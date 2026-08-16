import { POLL_INTERVAL_BACKGROUND_MS } from '../../config';
import { log } from '../../utils/logger';
import type { Multiplexer } from '../types';
import { isServerRunning } from '../types';
import { CmuxClosePolicy, type CmuxCloseReason } from './close-policy';
import { type CmuxSessionRecord, CmuxSessionStore } from './session-state';

export interface CmuxSessionEvent {
  type: string;
  properties?: {
    info?: {
      id?: string;
      parentID?: string;
      title?: string;
      directory?: string;
      sessionID?: string;
    };
    part?: { sessionID?: string };
    sessionID?: string;
    status?: { type: string };
  };
}

interface BackgroundJobs {
  deferIfRunning(session: string): boolean;
  clearDeferredClose(session: string): void;
}

export interface CmuxSessionLifecycleOptions {
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  deferredRetryMs?: number;
  deferredTtlMs?: number;
  /** @deprecated Missing status never establishes deletion. */
  missingGraceMs?: number;
  closeRetryMs?: number;
  closeRetryTtlMs?: number;
  closeRetryMaxAttempts?: number;
  orphanCooldownMs?: number;
  shutdownTimeoutMs?: number;
  isServerRunning?: (url: string) => Promise<boolean>;
  fetchStatuses?: () => Promise<Record<string, { type: string }>>;
  permanentlyClosedSessions?: Set<string>;
}

const ACTIVITY_EVENTS = new Set([
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
]);
const MIN_LIFETIME_MS = 10_000;
const IDLE_CONFIRMATIONS = 3;

function normalizeServerUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

class ServerUrlUnavailableError extends Error {
  constructor() {
    super('OpenCode server URL is unavailable');
    this.name = 'ServerUrlUnavailableError';
  }
}

export class CmuxSessionLifecycle {
  private readonly store = new CmuxSessionStore();
  private readonly policy: CmuxClosePolicy;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly injectedDelay: boolean;
  private readonly deferredRetryMs: number;
  private readonly deferredTtlMs: number;
  private readonly closeRetryMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly serverCheck: (url: string) => Promise<boolean>;
  private readonly fetchStatuses: () => Promise<
    Record<string, { type: string }>
  >;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private cleanupPromise?: Promise<void>;
  private disposed = false;
  private spawnGeneration = 0;
  private readonly permanentlyClosedSessions?: Set<string>;
  private readonly removeLatePaneObserver: () => void;

  constructor(
    private readonly owner: string,
    private readonly multiplexer: Multiplexer,
    private readonly resolveServerUrl: () => string | null,
    private readonly defaultDirectory: string,
    private readonly backgroundJobs?: BackgroundJobs,
    options: CmuxSessionLifecycleOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.permanentlyClosedSessions = options.permanentlyClosedSessions;
    this.injectedDelay = Boolean(options.delay);
    this.delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.deferredRetryMs = options.deferredRetryMs ?? 2_000;
    this.deferredTtlMs = options.deferredTtlMs ?? 300_000;
    this.closeRetryMs = options.closeRetryMs ?? 1_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.policy = new CmuxClosePolicy(
      options.closeRetryTtlMs,
      options.closeRetryMaxAttempts,
    );
    this.serverCheck = options.isServerRunning ?? isServerRunning;
    this.fetchStatuses = options.fetchStatuses ?? (() => this.loadStatuses());
    const serverScope = () => normalizeServerUrl(this.resolveServerUrl());
    this.removeLatePaneObserver = this.store.observeLatePaneOrphans(
      defaultDirectory,
      serverScope,
      () => this.claimLatePaneOrphans(),
    );
    this.recoverOrphans(
      this.store.claimOrphans(owner, defaultDirectory, serverScope),
    );
  }

  async onSessionCreated(event: CmuxSessionEvent): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    if (event.type !== 'session.created') return;
    const info = event.properties?.info;
    if (!info?.id || !info.parentID) return;
    if (this.permanentlyClosedSessions?.has(info.id)) return;
    const now = this.now();
    const record: CmuxSessionRecord = {
      session: info.id,
      owner: this.owner,
      parent: info.parentID,
      title: info.title ?? 'Subagent',
      directory: info.directory ?? this.defaultDirectory,
      spawnState: 'known',
      lifecycle: 'active',
      lastActivityAt: now,
      activityVersion: 0,
      idleConsecutive: 0,
    };
    if (!this.store.claimCreated(record)) {
      const current = this.store.get(record.session);
      if (
        current?.owner === this.owner &&
        current.paneId &&
        (current.lifecycle === 'orphaned' || current.lifecycle === 'deleted')
      )
        this.recoverOrphans([current]);
      return;
    }
    if (record.paneId && record.lifecycle !== 'active') {
      record.closeIntent = undefined;
      await this.requestClose(record, 'cleanup');
      return;
    }
    await this.spawn(record);
  }

  async onSessionStatus(event: CmuxSessionEvent): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    const session = this.eventSession(event);
    if (!session) return;
    const owned = this.store.get(session);
    if (!owned || owned.owner !== this.owner) return;
    if (ACTIVITY_EVENTS.has(event.type)) {
      this.activity(session);
      return;
    }
    const status =
      event.type === 'session.idle'
        ? 'idle'
        : event.type === 'session.status'
          ? event.properties?.status?.type
          : undefined;
    if (!status) return;
    if (status !== 'idle') {
      this.activity(session);
      this.backgroundJobs?.clearDeferredClose(session);
      const record = this.store.get(session);
      if (
        status === 'busy' &&
        record &&
        record.lifecycle === 'active' &&
        !record.paneId
      )
        await this.spawn(record);
    }
    if (owned.paneId) this.startPolling();
  }

  async onSessionDeleted(event: CmuxSessionEvent): Promise<void> {
    if (event.type !== 'session.deleted') return;
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    const session = this.eventSession(event);
    if (!session) return;
    const record = this.store.get(session);
    if (!record) return;
    if (record.owner !== this.owner) return;
    this.store.markDeleted(session);
    this.cancelDeferred(record);
    this.backgroundJobs?.clearDeferredClose(session);
    if (!record.paneId) {
      if (!record.spawnPromise) this.store.removeWithoutPane(session);
      return;
    }
    await this.requestClose(record, 'deleted');
  }

  async closeSessionFromCoordinator(session: string): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    const record = this.store.get(session);
    if (record?.paneId && record.owner === this.owner) {
      // This is independent terminal evidence. It may permit an absent map
      // entry, while a bare absent status remains non-terminal.
      record.terminalConfirmed = true;
      this.startPolling();
    }
  }

  async closeSessionPermanentlyFromCoordinator(session: string): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    this.permanentlyClosedSessions?.add(session);
    const record = this.store.get(session);
    if (!record || record.owner !== this.owner) return;
    record.lifecycle = 'deleted';
    this.cancelDeferred(record);
    this.backgroundJobs?.clearDeferredClose(session);
    if (!record.paneId) {
      if (!record.spawnPromise) this.store.removeWithoutPane(session);
      return;
    }
    await this.requestClose(record, 'deleted');
  }

  cleanup(): Promise<void> {
    this.cleanupPromise ??= this.runCleanup();
    return this.cleanupPromise;
  }

  /** Runs one status pass; exposed for deterministic lifecycle tests. */
  pollOnce(): Promise<void> {
    return this.poll();
  }

  private async spawn(
    record: CmuxSessionRecord,
    deferred = false,
  ): Promise<void> {
    if (
      this.disposed ||
      record.owner !== this.owner ||
      record.lifecycle !== 'active' ||
      this.permanentlyClosedSessions?.has(record.session)
    )
      return;
    if (record.spawnState === 'spawning' || record.paneId) return;
    const generation = this.spawnGeneration;
    const token = record.deferredSpawn?.generation;
    record.spawnState = 'spawning';
    const operation = this.spawnOperation(record);
    record.spawnPromise = operation;
    const result = await operation;
    if (record.spawnPromise === operation) record.spawnPromise = undefined;
    const current = this.store.get(record.session);
    const ownerChanged = current && current.owner !== this.owner;
    if (
      this.disposed ||
      generation !== this.spawnGeneration ||
      this.permanentlyClosedSessions?.has(record.session) ||
      ownerChanged
    ) {
      const latePane = result.paneId ?? result.orphanPaneId;
      if (latePane) await this.closeLatePane(record, latePane);
      if (current && current.owner === this.owner && !current.paneId)
        this.store.removeWithoutPane(record.session);
      return;
    }
    if (!current) {
      if (result.success && result.paneId)
        await this.adoptAndClose(record, result.paneId);
      if (result.orphanPaneId)
        await this.adoptAndClose(record, result.orphanPaneId);
      return;
    }
    if (
      deferred &&
      token !== undefined &&
      current.deferredSpawn?.generation !== token
    ) {
      const stalePane = result.paneId ?? result.orphanPaneId;
      if (stalePane) await this.adoptAndClose(current, stalePane);
      return;
    }
    const paneId = result.paneId ?? result.orphanPaneId;
    if (paneId) {
      this.store.markAttached(record.session, paneId, this.now());
      if (result.orphanPaneId) this.store.markOrphaned(record.session);
      if (current.lifecycle !== 'active' || result.orphanPaneId) {
        await this.requestClose(
          current,
          current.lifecycle === 'active' ? 'cleanup' : 'deleted',
        );
      } else this.startPolling();
      return;
    }
    current.spawnState = 'failed';
    if (current.lifecycle !== 'active') {
      this.store.removeWithoutPane(current.session);
    } else if (
      result.error === 'unavailable' ||
      result.error === 'not_found' ||
      result.error === 'invalid_state'
    ) {
      this.deferSpawn(current);
    }
  }

  private async spawnOperation(record: CmuxSessionRecord) {
    const serverUrl = this.resolveServerUrl();
    if (!serverUrl) {
      log('[cmux-session-lifecycle] no valid server URL; skipping spawn');
      return { success: false, error: 'unavailable' as const };
    }
    record.serverUrl = normalizeServerUrl(serverUrl);
    if (!(await this.serverCheck(serverUrl)))
      return { success: false, error: 'unavailable' as const };
    if (this.permanentlyClosedSessions?.has(record.session))
      return { success: false, error: 'unavailable' as const };
    try {
      return await this.multiplexer.spawnPane(
        record.session,
        record.title,
        serverUrl,
        record.directory,
      );
    } catch {
      return { success: false, error: 'hard' as const };
    }
  }

  private deferSpawn(record: CmuxSessionRecord): void {
    if (this.disposed || record.owner !== this.owner) return;
    const existing = record.deferredSpawn;
    const deferred = existing ?? {
      deadline: this.now() + this.deferredTtlMs,
      generation: 0,
    };
    deferred.generation += 1;
    deferred.timer?.cancel();
    record.deferredSpawn = deferred;
    if (this.now() >= deferred.deadline) {
      this.cancelDeferred(record);
      return;
    }
    deferred.timer = this.timer(async () => {
      deferred.timer = undefined;
      if (
        this.disposed ||
        this.store.get(record.session) !== record ||
        record.lifecycle !== 'active' ||
        record.owner !== this.owner ||
        this.permanentlyClosedSessions?.has(record.session)
      )
        return;
      await this.spawn(record, true);
    }, this.deferredRetryMs);
  }

  private cancelDeferred(record: CmuxSessionRecord): void {
    record.deferredSpawn?.timer?.cancel();
    record.deferredSpawn = undefined;
  }

  private activity(session: string): void {
    const record = this.store.get(session);
    if (!record || record.owner !== this.owner || this.disposed) return;
    this.store.markActivity(session, this.now());
    record.terminalConfirmed = false;
    const next = this.policy.activity(record.closeIntent);
    if (!next && record.closeIntent) record.closeTimer?.cancel();
    record.closeIntent = next;
    if (!next) record.closeTimer = undefined;
  }

  private async requestClose(
    record: CmuxSessionRecord,
    reason: CmuxCloseReason,
  ): Promise<void> {
    if (!record.paneId || record.owner !== this.owner) return;
    if (
      reason === 'idle' &&
      !(this.backgroundJobs?.deferIfRunning(record.session) ?? true)
    )
      return;
    const previous = record.closeIntent;
    record.closeIntent = this.policy.request(
      reason,
      record.activityVersion,
      this.now(),
      previous,
    );
    if (previous !== record.closeIntent) record.closeTimer?.cancel();
    await this.attemptClose(record);
  }

  private async attemptClose(record: CmuxSessionRecord): Promise<void> {
    if (record.closePromise) {
      await record.closePromise;
      if (record.paneId && record.closeIntent) await this.attemptClose(record);
      return;
    }
    const operation = this.performClose(record);
    const trackedOperation = operation.finally(() => {
      if (record.closePromise === trackedOperation) {
        record.closePromise = undefined;
        this.store.notifyLatePaneOrphan(record);
      }
    });
    record.closePromise = trackedOperation;
    await trackedOperation;
  }

  private async performClose(record: CmuxSessionRecord): Promise<void> {
    const intent = record.closeIntent;
    if (
      !intent ||
      !record.paneId ||
      record.owner !== this.owner ||
      this.store.get(record.session) !== record
    )
      return;
    if (intent.phase === 'cooldown' && this.now() < intent.nextAttemptAt) {
      this.scheduleCooldown(record);
      return;
    }
    record.closeIntent = this.policy.resume(intent, this.now());
    if (record.closeIntent !== intent) return this.performClose(record);
    if (
      intent.reason === 'idle' &&
      intent.expectedActivityVersion !== record.activityVersion
    ) {
      record.closeIntent = this.policy.activity(intent);
      return;
    }
    const paneId = record.paneId;
    let closed = false;
    try {
      // Await completion before any retry so the pane ID is never reused while
      // an older adapter kill may still be running.
      closed = await this.multiplexer.closePane(paneId);
    } catch (error) {
      log('[cmux-session-lifecycle] closePane failed; retaining pane', {
        owner: this.owner,
        session: record.session,
        paneId,
        error: String(error),
      });
    }
    const current = this.store.get(record.session);
    const ownerChanged =
      current === record &&
      record.owner !== this.owner &&
      record.paneId === paneId;
    if (ownerChanged) record.closeSettlement = { paneId, closed };
    else record.closeSettlement = undefined;
    if (
      (this.disposed &&
        !(record.lifecycle === 'orphaned' && intent.reason === 'cleanup')) ||
      current !== record ||
      record.owner !== this.owner ||
      record.closeIntent !== intent ||
      record.paneId !== paneId
    )
      return;
    const intentStillCurrent = record.closeIntent === intent;
    const idleStillCurrent =
      intent.reason !== 'idle' ||
      intent.expectedActivityVersion === record.activityVersion;
    if (closed) {
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      if (record.lifecycle !== 'active') {
        this.store.removeAfterConfirmedClose(record.session);
      } else {
        record.paneId = undefined;
        record.spawnState = 'known';
        if (intentStillCurrent) record.closeIntent = this.policy.complete();
        if (
          intent.reason === 'idle' &&
          record.owner === this.owner &&
          !this.disposed &&
          record.activityVersion !== intent.expectedActivityVersion
        )
          await this.spawn(record);
      }
      this.updatePolling();
      return;
    }
    if (!intentStillCurrent || !idleStillCurrent) return;
    record.closeIntent = this.policy.failed(intent, this.now());
    if (record.closeIntent.phase === 'cooldown') {
      if (!Number.isFinite(record.closeIntent.nextAttemptAt))
        this.store.markOrphaned(record.session);
      this.scheduleCooldown(record);
      return;
    }
    record.closeTimer?.cancel();
    record.closeTimer = this.timer(
      () => this.attemptClose(record),
      this.closeRetryMs,
    );
  }

  private scheduleCooldown(record: CmuxSessionRecord): void {
    record.closeTimer?.cancel();
    record.closeTimer = undefined;
    const intent = record.closeIntent;
    if (!intent || !Number.isFinite(intent.nextAttemptAt) || this.disposed)
      return;
    record.closeTimer = this.timer(
      () => this.attemptClose(record),
      Math.max(0, intent.nextAttemptAt - this.now()),
    );
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    if (this.polling) return;
    this.polling = true;
    try {
      const statuses = await this.fetchStatuses();
      for (const record of this.store.ownedBy(this.owner)) {
        if (!record.paneId || record.lifecycle !== 'active') continue;
        const status = statuses[record.session];
        if (!status) {
          record.statusMissingSince ??= this.now();
          record.idleConsecutive = 0;
          if (record.terminalConfirmed) await this.requestClose(record, 'idle');
          else
            log('[cmux-session-lifecycle] status absent; retaining pane', {
              owner: this.owner,
              session: record.session,
              paneId: record.paneId,
              missingForMs: this.now() - record.statusMissingSince,
              recovery:
                'requires-session.deleted-or-reliable-existence-evidence',
            });
          continue;
        }
        record.statusMissingSince = undefined;
        if (status.type !== 'idle') {
          this.activity(record.session);
          continue;
        }
        if (
          this.now() - (record.attachedAt ?? this.now()) < MIN_LIFETIME_MS ||
          this.now() - record.lastActivityAt < MIN_LIFETIME_MS
        ) {
          record.idleConsecutive = 0;
          continue;
        }
        record.idleConsecutive += 1;
        if (record.idleConsecutive < IDLE_CONFIRMATIONS) continue;
        const version = record.activityVersion;
        const final = await this.fetchStatuses();
        if (
          final[record.session]?.type === 'idle' &&
          version === record.activityVersion
        )
          await this.requestClose(record, 'idle');
        else if (!final[record.session] && record.terminalConfirmed)
          await this.requestClose(record, 'idle');
        else if (!final[record.session])
          log('[cmux-session-lifecycle] final status absent; retaining pane', {
            owner: this.owner,
            session: record.session,
            paneId: record.paneId,
          });
        else this.activity(record.session);
      }
    } catch {
      // A transient status endpoint failure must not reject the interval task.
    } finally {
      this.polling = false;
    }
  }

  private resumeTransferredClose(record: CmuxSessionRecord): void {
    const closePromise = record.closePromise;
    if (!closePromise) return;
    void closePromise.then(() => {
      if (
        this.disposed ||
        this.store.get(record.session) !== record ||
        record.owner !== this.owner ||
        !record.paneId
      )
        return;
      if (this.applyCloseSettlement(record)) return;
      void this.requestClose(record, 'cleanup');
    });
  }

  private applyCloseSettlement(record: CmuxSessionRecord): boolean {
    const settlement = this.store.consumeCloseSettlement(record);
    if (!settlement) return false;
    if (!settlement.closed) return false;
    this.store.removeAfterConfirmedClose(record.session);
    this.updatePolling();
    return true;
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(
      () => void this.poll().catch(() => undefined),
      POLL_INTERVAL_BACKGROUND_MS,
    );
    this.pollTimer.unref?.();
  }

  private updatePolling(): void {
    if (
      this.store
        .ownedBy(this.owner)
        .some((record) => record.paneId && record.lifecycle === 'active')
    )
      this.startPolling();
    else if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async waitForSpawnSettlement(
    pending: Promise<unknown>[],
  ): Promise<void> {
    if (pending.length === 0) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      let nativeTimer: ReturnType<typeof setTimeout> | undefined;
      let injectedTimer: { cancel(): void } | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (nativeTimer) clearTimeout(nativeTimer);
        injectedTimer?.cancel();
        resolve();
      };

      nativeTimer = setTimeout(finish, this.shutdownTimeoutMs);
      nativeTimer.unref?.();
      if (this.injectedDelay)
        injectedTimer = this.timer(finish, this.shutdownTimeoutMs);
      void Promise.allSettled(pending).then(finish, finish);
    });
  }

  private async runCleanup(): Promise<void> {
    this.disposed = true;
    this.removeLatePaneObserver();
    this.spawnGeneration += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const records = this.store.ownedBy(this.owner);
    for (const record of records) this.cancelDeferred(record);
    const pending = records.flatMap((record) =>
      record.spawnPromise ? [record.spawnPromise] : [],
    );
    await this.waitForSpawnSettlement(pending);
    const pendingCloses = this.store
      .ownedBy(this.owner)
      .flatMap((record) => (record.closePromise ? [record.closePromise] : []));
    if (pendingCloses.length) await Promise.all(pendingCloses);
    for (const record of this.store.ownedBy(this.owner)) {
      if (!record.paneId) {
        if (!record.spawnPromise) this.store.removeWithoutPane(record.session);
        continue;
      }
      if (this.applyCloseSettlement(record)) continue;
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      record.closeIntent = this.policy.request(
        'cleanup',
        record.activityVersion,
        this.now(),
      );
      while (
        record.closeIntent?.phase === 'pending' &&
        this.store.get(record.session) === record &&
        record.owner === this.owner
      ) {
        await this.attemptCloseWithoutTimer(record);
        if (record.closeIntent?.phase === 'pending')
          await this.delay(this.closeRetryMs);
      }
      if (
        record.closeIntent &&
        this.store.get(record.session) === record &&
        record.owner === this.owner
      )
        this.store.markOrphaned(record.session);
    }
  }

  private async attemptCloseWithoutTimer(
    record: CmuxSessionRecord,
  ): Promise<void> {
    if (record.closePromise) {
      await record.closePromise;
      return;
    }
    const operation = this.performCloseWithoutTimer(record);
    const trackedOperation = operation.finally(() => {
      if (record.closePromise === trackedOperation) {
        record.closePromise = undefined;
        this.store.notifyLatePaneOrphan(record);
      }
    });
    record.closePromise = trackedOperation;
    await trackedOperation;
  }

  private async performCloseWithoutTimer(
    record: CmuxSessionRecord,
  ): Promise<void> {
    const intent = record.closeIntent;
    if (!intent || !record.paneId) return;
    const paneId = record.paneId;
    let closed = false;
    try {
      closed = await this.multiplexer.closePane(paneId);
    } catch (error) {
      log('[cmux-session-lifecycle] cleanup closePane failed; retaining pane', {
        owner: this.owner,
        session: record.session,
        paneId,
        error: String(error),
      });
    }
    const current = this.store.get(record.session);
    const ownerChanged =
      current === record &&
      record.owner !== this.owner &&
      record.paneId === paneId;
    if (ownerChanged) record.closeSettlement = { paneId, closed };
    else record.closeSettlement = undefined;
    if (
      current !== record ||
      record.owner !== this.owner ||
      record.closeIntent !== intent ||
      record.paneId !== paneId
    )
      return;
    if (closed) {
      record.closeIntent = undefined;
      this.store.removeAfterConfirmedClose(record.session);
    } else record.closeIntent = this.policy.failed(intent, this.now());
  }

  private async adoptAndClose(
    record: CmuxSessionRecord,
    paneId: string,
  ): Promise<void> {
    if (!this.store.get(record.session)) this.store.claimCreated(record);
    this.store.markAttached(record.session, paneId, this.now());
    this.store.markOrphaned(record.session);
    await this.requestClose(record, 'cleanup');
  }

  private async closeLatePane(
    source: CmuxSessionRecord,
    paneId: string,
  ): Promise<void> {
    const session = `${source.session}\0late\0${paneId}`;
    const existing = this.store.get(session);
    if (existing) {
      if (existing.owner !== this.owner || existing.paneId !== paneId) return;
      await this.requestClose(existing, 'cleanup');
      return;
    }

    const late: CmuxSessionRecord = {
      session,
      owner: this.owner,
      parent: source.parent,
      title: source.title,
      directory: source.directory,
      paneId,
      spawnState: 'attached',
      lifecycle: 'orphaned',
      serverUrl: source.serverUrl,
      attachedAt: this.now(),
      lastActivityAt: source.lastActivityAt,
      activityVersion: source.activityVersion,
      idleConsecutive: 0,
      latePaneCleanup: true,
    };
    if (!this.store.claimCreated(late)) return;
    const current = this.store.get(session);
    if (current !== late || current.owner !== this.owner) return;

    // Keep this as a normal owner-scoped close intent. It may run after this
    // lifecycle is disposed, and a later lifecycle can claim the record if a
    // retry enters cooldown.
    await this.requestClose(current, 'cleanup');
  }

  private claimLatePaneOrphans(): void {
    const serverUrl = normalizeServerUrl(this.resolveServerUrl());
    if (!serverUrl) return;
    const claimed = this.store.claimLatePaneOrphans(
      this.owner,
      this.defaultDirectory,
      serverUrl,
    );
    this.recoverOrphans(claimed);
  }

  private recoverOrphans(orphaned: CmuxSessionRecord[]): void {
    for (const orphan of orphaned) {
      if (orphan.closePromise) {
        this.resumeTransferredClose(orphan);
        continue;
      }
      if (this.applyCloseSettlement(orphan)) continue;
      if (
        orphan.closeIntent?.phase === 'cooldown' &&
        Number.isFinite(orphan.closeIntent.nextAttemptAt)
      ) {
        this.scheduleCooldown(orphan);
      } else {
        orphan.closeIntent = undefined;
        void this.requestClose(orphan, 'cleanup');
      }
    }
  }

  private eventSession(event: CmuxSessionEvent): string | undefined {
    return (
      event.properties?.sessionID ??
      event.properties?.info?.sessionID ??
      event.properties?.part?.sessionID ??
      event.properties?.info?.id
    );
  }

  private timer(callback: () => void | Promise<void>, milliseconds: number) {
    let cancelled = false;
    if (this.injectedDelay) {
      void this.delay(milliseconds).then(() => {
        if (!cancelled) void callback();
      });
      return { cancel: () => (cancelled = true) };
    }
    const timer = setTimeout(() => void callback(), milliseconds);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }

  private async loadStatuses(): Promise<Record<string, { type: string }>> {
    const serverUrl = this.resolveServerUrl();
    if (!serverUrl) {
      log('[cmux-session-lifecycle] no valid server URL; skipping poll');
      throw new ServerUrlUnavailableError();
    }
    const response = await fetch(new URL('/session/status', serverUrl), {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok)
      throw new Error(`session status failed: ${response.status}`);
    return (await response.json()) as Record<string, { type: string }>;
  }
}
