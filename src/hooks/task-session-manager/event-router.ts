/**
 * Event router for task session manager.
 *
 * Routes lifecycle events (session.created, server.instance.disposed,
 * session.idle, session.error, session.status, session.deleted) to
 * the appropriate subsystems.
 */
import type { BackgroundJobExecution } from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import { log } from '../../utils/logger';
import {
  isFailoverError,
  isInlineFailoverError,
} from '../foreground-fallback/index';
import type {
  InjectedTerminalJobs,
  RetainedBoardSnapshotState,
} from './board-injection';
import type { PendingTaskCall } from './pending-call-tracker';

export async function handleEvent(
  input: {
    event: {
      type: string;
      properties?: {
        info?: { id?: string; parentID?: string; agent?: string };
        id?: string;
        requestID?: string;
        sessionID?: string;
        status?: { type?: string };
        error?: { name?: string };
      };
    };
  },
  deps: {
    inputWaits: {
      trackInputWait(event: {
        type: string;
        properties?: {
          id?: string;
          requestID?: string;
          sessionID?: string;
        };
      }): void;
      clearInputWaits(sessionID: string): void;
      waitsByParent: Map<string, Set<string | symbol>>;
    };
    continuationTokens: {
      clearContinuation(sessionID: string): void;
      invalidateContinuation(sessionID: string): void;
      /** Release local uncommitted reservations only; keep global consumed. */
      disposeLocalState(): void;
      sessionTokens: Map<string, symbol>;
      evaluations: Map<string, Set<symbol>>;
      consumed: { has(sessionID: string): boolean };
    };
    options: {
      shouldManageSession: (sessionID: string) => boolean;
      registerSessionAsOrchestrator?: (sessionID: string) => void;
      isFallbackInProgress?: (sessionID: string) => boolean;
      /** True when foreground fallback could still recover the session. */
      willAttemptFallback?: (sessionID: string) => boolean;
    };
    idleReconciler: {
      scheduleIdleReconciliation(sessionID: string): void;
      scheduleChildIdleReconciliation(
        sessionID: string,
        idleObservedAt: number,
      ): void;
      scheduleErrorTerminalize(sessionID: string, idleObservedAt: number): void;
      clearIdleTimers(sessionID: string): void;
      clearAllTimers(): string[];
    };
    /** Sessions with a deferred inline 401/410 awaiting fallback outcome. */
    deferredInlineErrors: Set<string>;
    backgroundJobBoard: BackgroundJobStore;
    pendingCallTracker: {
      peekByParentAndAgent(
        parentSessionID: string,
        agentHint?: string,
      ): PendingTaskCall | undefined;
      clearSession(sessionID: string): void;
    };
    taskContextTracker: {
      pendingManagedTaskIds: Set<string>;
      clearSession(sessionID: string): void;
      prune(board: { taskIDs(): Set<string> }): void;
    };
    terminalJobsInjectedByParent: Map<string, InjectedTerminalJobs>;
    pendingInjectedTerminalJobsByParent: Map<
      string,
      Map<string, BackgroundJobExecution>
    >;
    retainedBoardSnapshots: Map<string, RetainedBoardSnapshotState>;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
  },
): Promise<void> {
  deps.inputWaits.trackInputWait(input.event);

  if (input.event.type === 'session.created') {
    const info = input.event.properties?.info;
    if (info?.id) deps.retainedBoardSnapshots.delete(info.id);
    log('[task-session-manager] session.created observed', {
      sessionID: info?.id,
      parentSessionID: info?.parentID,
      managesParent: info?.parentID
        ? deps.options.shouldManageSession(info.parentID)
        : false,
    });
    if (
      info?.id &&
      info.parentID &&
      deps.options.shouldManageSession(info.parentID)
    ) {
      deps.taskContextTracker.pendingManagedTaskIds.add(info.id);
      // Early board registration: if the parent tool call is cancelled
      // before tool.execute.after (e.g. foreground fallback abort), the
      // after-hook never fires and the job is never tracked — idle then
      // reports runningJobForSession:false and the orchestrator sees
      // "Task cancelled" while the child is still working (#765).
      // Peek (don't take) so tool.execute.after can still re-register.
      //
      // When the parent has multiple task calls in flight at once (e.g.
      // parallel council reviewers), `info.agent` on the child session
      // identifies which subagent started it; prefer the matching
      // pending call so we don't attribute the child to the wrong agent.
      const pending = deps.pendingCallTracker.peekByParentAndAgent(
        info.parentID,
        info.agent,
      );
      if (
        pending &&
        !pending.resumedTaskId &&
        !deps.backgroundJobBoard.get(info.id)
      ) {
        const record = deps.backgroundJobBoard.registerLaunch({
          taskID: info.id,
          parentSessionID: pending.parentSessionId,
          agent: pending.agentType,
          description: pending.label,
          objective: pending.label,
          // session.created has no reliable call identity. Keep this
          // registration tentative so an unrelated foreground call cannot
          // accidentally arm wall-clock supervision.
          background: false,
        });
        log(
          '[task-session-manager] tentative early board registration from session.created',
          {
            taskID: record.taskID,
            alias: record.alias,
            parentSessionID: record.parentSessionID,
            agent: record.agent,
          },
        );
      }
    }
    return;
  }

  if (input.event.type === 'server.instance.disposed') {
    deps.backgroundJobSupervisor?.dispose();
    deps.retainedBoardSnapshots.clear();
    const idleSessionIds = deps.idleReconciler.clearAllTimers();
    // Local-only: release this instance's uncommitted reservations and drop
    // local tokens/evaluations. Do not enumerate or clear process-global
    // consumed attempts owned by the shared gate.
    const waitSessionIDs = new Set([
      ...idleSessionIds,
      ...deps.continuationTokens.sessionTokens.keys(),
      ...deps.continuationTokens.evaluations.keys(),
      ...deps.inputWaits.waitsByParent.keys(),
    ]);
    deps.continuationTokens.disposeLocalState();
    for (const sessionID of waitSessionIDs) {
      deps.inputWaits.clearInputWaits(sessionID);
    }
    return;
  }

  if (
    input.event.type === 'session.idle' ||
    (input.event.type === 'session.status' &&
      (input.event.properties as { status?: { type?: string } } | undefined)
        ?.status?.type === 'idle')
  ) {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const job = sessionId ? deps.backgroundJobBoard.get(sessionId) : undefined;
    log('[task-session-manager] idle/status idle observed', {
      sessionID: sessionId,
      managesSession: sessionId
        ? deps.options.shouldManageSession(sessionId)
        : false,
      terminalJobsPending: sessionId
        ? (deps.terminalJobsInjectedByParent.get(sessionId)?.executions.size ??
            0) +
          (deps.pendingInjectedTerminalJobsByParent.get(sessionId)?.size ?? 0)
        : 0,
      runningJobForSession: job?.state === 'running' || false,
    });
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      deps.idleReconciler.scheduleIdleReconciliation(sessionId);
    }

    // Fallback: for background child sessions that go idle without
    // an injected completion, reconcile the board entry since the
    // session being idle is itself the completion signal.
    // Delayed so FG can claim the session before we mark completed.
    if (job && sessionId && job.state === 'running') {
      if (deps.deferredInlineErrors.has(sessionId)) {
        // A persistent 401/410 was deferred for fallback recovery but the
        // session ended without one: terminalize as error instead of the
        // false completion the child-idle path would record.
        deps.idleReconciler.scheduleErrorTerminalize(sessionId, Date.now());
      } else {
        deps.idleReconciler.scheduleChildIdleReconciliation(
          sessionId,
          Date.now(),
        );
      }
    }
    return;
  }

  if (input.event.type === 'session.error') {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    if (sessionId) {
      deps.continuationTokens.invalidateContinuation(sessionId);
    }
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      const props = input.event.properties as { error?: unknown } | undefined;
      // Only clear injected terminal jobs for fatal errors.
      // Rate-limit errors are recovered by ForegroundFallbackManager
      // (abort + reprompt with fallback model); clearing the injected
      // job state here would make the orchestrator lose track of
      // completed background tasks and unable to dispatch follow-ups.
      // Persistent 401/410 (auth, model gone) may ALSO be recovered by a
      // fallback reprompt, so defer while recovery is still possible:
      // record the deferred error in the set so an idle with no recovery
      // terminalizes the job as 'error' instead of a false completion.
      // When no chain exists, fallback is disabled, or the chain is
      // exhausted the error is final — record it now.
      if (
        !props?.error ||
        !isFailoverError(props.error) ||
        (isInlineFailoverError(props.error) &&
          !deps.options.willAttemptFallback?.(sessionId))
      ) {
        deps.deferredInlineErrors.delete(sessionId);
        deps.terminalJobsInjectedByParent.delete(sessionId);
        deps.pendingInjectedTerminalJobsByParent.delete(sessionId);
        // Record non-retryable errors on the job board so the
        // orchestrator sees the failure instead of a false completion.
        const job = deps.backgroundJobBoard.get(sessionId);
        if (job && job.state === 'running') {
          deps.backgroundJobBoard.updateStatus({
            taskID: sessionId,
            state: 'error',
            resultSummary:
              (props?.error as { message?: string } | undefined)?.message ??
              'Session error',
          });
        }
      } else if (isInlineFailoverError(props.error)) {
        // Recovery possible: defer. The idle backstop terminalizes this
        // if the fallback fails silently; busy/deleted clears it.
        deps.deferredInlineErrors.add(sessionId);
      }
    } else if (sessionId) {
      // Child subagent sessions are not orchestrators, so the block
      // above never runs for them. Without this, a failed background
      // subagent leaves its job in `running` and the idle-reconciliation
      // path (which has no shouldManageSession guard) marks it
      // `completed` — a false success. A child with no fallback chain has
      // nothing to retry into, so surface the failure on the board.
      const props = input.event.properties as { error?: unknown } | undefined;
      if (deps.options.isFallbackInProgress?.(sessionId)) return;
      const job = deps.backgroundJobBoard.get(sessionId);
      if (job && job.state === 'running') {
        deps.backgroundJobBoard.updateStatus({
          taskID: sessionId,
          state: 'error',
          resultSummary:
            (props?.error as { message?: string } | undefined)?.message ??
            'Session error',
        });
      }
    }

    return;
  }

  if (input.event.type === 'session.status') {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const statusType = (
      input.event.properties as { status?: { type?: string } } | undefined
    )?.status?.type;
    if (sessionId) deps.continuationTokens.invalidateContinuation(sessionId);
    if (statusType !== 'busy') {
      return;
    }
    // Live busy cancels a pending child idle-reconcile — the session
    // recovered (FG re-prompt or continued work).
    // Note: invalidateContinuation above already cleared the parent
    // idle-reconcile timer; clearIdleTimers handles the child timer.
    if (sessionId) {
      deps.idleReconciler.clearIdleTimers(sessionId);
      // Live busy after a deferred 401/410 means the fallback re-prompt
      // (or continued work) recovered the session — the error is not final.
      deps.deferredInlineErrors.delete(sessionId);
    }
    const before = sessionId
      ? deps.backgroundJobBoard.get(sessionId)
      : undefined;
    const updated = sessionId
      ? deps.backgroundJobBoard.markRunningFromLiveSession(sessionId)
      : undefined;
    if (before?.cancellationRequested) {
      log('[task-session-manager] busy observed after cancel request', {
        sessionID: sessionId,
        previousState: before.state,
        previousTerminalState: before.terminalState,
        terminalUnreconciled: before.terminalUnreconciled,
        resultSummary: before.resultSummary,
      });
    }
    log('[task-session-manager] busy/status busy observed', {
      sessionID: sessionId,
      managesSession: sessionId
        ? deps.options.shouldManageSession(sessionId)
        : false,
      previousState: before?.state,
      previousTerminalState: before?.terminalState,
      previousCancellationRequested: before?.cancellationRequested ?? false,
      previousLastLiveBusyAt: before?.lastLiveBusyAt,
      updatedState: updated?.state,
      updatedCancellationRequested: updated?.cancellationRequested ?? false,
      updatedLastLiveBusyAt: updated?.lastLiveBusyAt,
    });
    return;
  }

  if (input.event.type !== 'session.deleted') return;
  const sessionId =
    input.event.properties?.info?.id || input.event.properties?.sessionID;
  if (!sessionId) return;

  // Foreground-fallback teardown recreates the session; preserve a committed
  // continuation attempt so the epoch is not rearmed without a real user message.
  // Genuine deletion clears process-global attempt state for the session.
  if (deps.options.isFallbackInProgress?.(sessionId)) {
    deps.continuationTokens.invalidateContinuation(sessionId);
  } else {
    deps.continuationTokens.clearContinuation(sessionId);
  }
  deps.inputWaits.clearInputWaits(sessionId);
  deps.retainedBoardSnapshots.delete(sessionId);
  const fallbackInProgress =
    deps.options.isFallbackInProgress?.(sessionId) === true;
  const job = deps.backgroundJobBoard.get(sessionId);
  if (!fallbackInProgress || job?.deadlineExceededAt !== undefined) {
    deps.backgroundJobSupervisor?.onSessionDeleted(sessionId);
  }

  log('[task-session-manager] session.deleted observed', {
    sessionID: sessionId,
  });
}
