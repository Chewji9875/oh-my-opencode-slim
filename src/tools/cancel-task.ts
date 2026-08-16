import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobLease } from '../utils/background-job-board';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { log } from '../utils/logger';
import { getClient } from '../utils/opencode-client';
import { delay } from '../utils/polling';
import {
  OperationTimeoutError,
  SESSION_ID_PATTERN,
  withTimeout,
} from '../utils/session';

const z = tool.schema;

interface CancelTaskToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  shouldManageSession: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
  verifyAbortMs?: number;
  abortRetryIntervalMs?: number;
  stableStoppedMs?: number;
  deleteTimeoutMs?: number;
  deleteVerifyMs?: number;
  deleteStableStoppedMs?: number;
}

class SessionStillRunningError extends Error {}

class LeaseOwnershipLostError extends Error {}

class LeaseOperationTimeoutError extends Error {
  constructor(
    message: string,
    readonly pending: boolean,
  ) {
    super(message);
    this.name = 'LeaseOperationTimeoutError';
  }
}

export function createCancelTaskTool(
  options: CancelTaskToolOptions,
): Record<string, ToolDefinition> {
  const cancel_task = tool({
    description: `Cancel a tracked background specialist task.

Use only for obsolete, wrong, conflicting, or user-requested cancellation. Accepts either the native task_id/session ID or the parent-scoped alias shown in the Background Job Board. Cancellation is not rollback: if cancelling a writer, inspect and reconcile partial file changes before replacing the lane.`,
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      reason: z.string().optional().describe('Short cancellation reason'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('cancel_task requires sessionID');
      if (toolContext.agent && toolContext.agent !== 'orchestrator') {
        throw new Error('cancel_task can only be used by orchestrator');
      }
      if (!options.shouldManageSession(parentSessionID)) {
        throw new Error(
          'cancel_task can only be used in orchestrator sessions',
        );
      }

      const requested = args.task_id.trim();
      if (!requested) throw new Error('cancel_task requires task_id');

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      log('[cancel-task] request received', {
        parentSessionID,
        requested,
        resolvedTaskID: job?.taskID,
        alias: job
          ? options.backgroundJobBoard.field(job.taskID, 'alias')
          : undefined,
        state: job
          ? options.backgroundJobBoard.field(job.taskID, 'state')
          : undefined,
        terminalState: job
          ? options.backgroundJobBoard.field(job.taskID, 'terminalState')
          : undefined,
        cancellationRequested: job?.cancellationRequested,
      });
      if (!job) {
        if (SESSION_ID_PATTERN.test(requested)) {
          if (requested === parentSessionID) {
            log('[cancel-task] rejected parent session cancellation', {
              parentSessionID,
              taskID: requested,
            });
            return unknownTaskOutput(requested, 'cannot cancel parent session');
          }

          const knownJob = options.backgroundJobBoard.get(requested);
          const ownerParentSessionID =
            options.backgroundJobBoard.getParentSessionID(requested);
          if (knownJob && ownerParentSessionID !== parentSessionID) {
            log('[cancel-task] rejected unowned tracked raw session', {
              parentSessionID,
              taskID: requested,
              ownerParentSessionID,
            });
            return unknownTaskOutput(
              requested,
              'unknown or unowned background task',
            );
          }

          const parentID = await getSessionParentID(options.input, requested);
          if (parentID !== parentSessionID) {
            log('[cancel-task] rejected raw session without parent ownership', {
              parentSessionID,
              taskID: requested,
              actualParentID: parentID,
            });
            return unknownTaskOutput(
              requested,
              'unknown or unowned background task',
            );
          }

          log(
            '[cancel-task] refusing destructive action for untracked raw session',
            {
              parentSessionID,
              taskID: requested,
            },
          );
          return unknownTaskOutput(
            requested,
            'best-effort/uncertain cancellation: session ownership was observed, but no tracked generation exists; no remote abort or delete was attempted',
          );
        }

        return unknownTaskOutput(
          requested,
          'unknown or unowned background task',
        );
      }

      const capturedExecution = {
        taskID: job.taskID,
        generation: job.generation,
      };
      const cancellationLease =
        options.backgroundJobBoard.acquireCancellationLease(
          capturedExecution.taskID,
          capturedExecution.generation,
        );
      if (!cancellationLease) {
        return staleCancellationOutput(
          options,
          capturedExecution,
          'cancellation lease unavailable; no remote operation was attempted',
        );
      }
      try {
        await abortAndVerifySession(
          options,
          capturedExecution,
          cancellationLease,
        );
        if (!options.backgroundJobBoard.validateLease(cancellationLease)) {
          return staleCancellationOutput(options, capturedExecution);
        }
      } catch (error) {
        const stillRunning = error instanceof SessionStillRunningError;
        const boardRunning = options.backgroundJobBoard.isRunning(
          capturedExecution.taskID,
        );
        log('[cancel-task] abort failed', {
          taskID: capturedExecution.taskID,
          stillRunning,
          boardRunning,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!options.backgroundJobBoard.validateLease(cancellationLease)) {
          return staleCancellationOutput(options, capturedExecution);
        }
        const message = error instanceof Error ? error.message : String(error);
        const updated = options.backgroundJobBoard.markStatusUncertain(
          capturedExecution.taskID,
          message,
          capturedExecution.generation,
        );
        const quarantined =
          error instanceof LeaseOperationTimeoutError && error.pending;
        if (!isCapturedExecution(updated, capturedExecution)) {
          if (!quarantined) {
            options.backgroundJobBoard.releaseLease(cancellationLease);
          }
          return staleCancellationOutput(options, capturedExecution);
        }
        if (!quarantined) {
          options.backgroundJobBoard.releaseLease(cancellationLease);
        }
        return [
          `task_id: ${capturedExecution.taskID}`,
          `state: ${updated?.state ?? 'unknown'}`,
          '',
          '<task_error>',
          message,
          '</task_error>',
        ].join('\n');
      }

      const cancellationOptions = {
        force: true,
        expectedGeneration: capturedExecution.generation,
        cancellationLease,
      };
      const marked = options.backgroundJobBoard.markCancelled(
        capturedExecution.taskID,
        args.reason,
        Date.now(),
        cancellationOptions,
      );
      if (!isCapturedExecution(marked, capturedExecution)) {
        options.backgroundJobBoard.releaseLease(cancellationLease);
        return staleCancellationOutput(options, capturedExecution);
      }
      if (!options.backgroundJobBoard.validateLease(cancellationLease)) {
        return staleCancellationOutput(options, capturedExecution);
      }
      const state = options.backgroundJobBoard.getState(
        capturedExecution.taskID,
      );
      log('[cancel-task] marked job cancelled after verified abort', {
        taskID: capturedExecution.taskID,
        alias: options.backgroundJobBoard.field(
          capturedExecution.taskID,
          'alias',
        ),
        state,
        cancellationRequested: options.backgroundJobBoard.field(
          capturedExecution.taskID,
          'cancellationRequested',
        ),
      });
      options.backgroundJobBoard.releaseLease(cancellationLease);

      return [
        `task_id: ${capturedExecution.taskID}`,
        `state: ${state ?? 'cancelled'}`,
        '',
        '<task_error>',
        options.backgroundJobBoard.getResultSummary(capturedExecution.taskID) ??
          'cancelled',
        '</task_error>',
      ].join('\n');
    },
  });

  return { cancel_task };
}

async function abortAndVerifySession(
  options: CancelTaskToolOptions,
  execution: { taskID: string; generation: number },
  lease: BackgroundJobLease,
): Promise<void> {
  const taskID = execution.taskID;
  let abortConfirmed = false;
  log('[cancel-task] abort attempt starting', { taskID });
  assertLease(options.backgroundJobBoard, lease, execution);
  try {
    const response = await awaitLeaseOperation(
      options.backgroundJobBoard,
      lease,
      () => getClient(options.input).session.abort({ path: { id: taskID } }),
      options.abortTimeoutMs ?? 10_000,
      `Session abort timed out after ${options.abortTimeoutMs ?? 10_000}ms`,
    );
    assertLease(options.backgroundJobBoard, lease, execution);
    const responseError = operationError(response);
    if (responseError !== undefined) throw responseError;
    const responseData = operationBoolean(response);
    if (responseData === false) {
      throw new Error(`Session abort was not confirmed: ${taskID}`);
    }
    abortConfirmed = responseData === true;
    log('[cancel-task] abort call returned', { taskID });
  } catch (error) {
    if (error instanceof LeaseOperationTimeoutError) throw error;
    assertLease(options.backgroundJobBoard, lease, execution);
    abortConfirmed = isExplicitSessionAbsence(error);
    log('[cancel-task] abort call failed', {
      taskID,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ponytail: v1 had a polling loop here that verified abort succeeded before
  // proceeding to delete. v2 abort is server-side and synchronous — the delete
  // verification loop below catches any remaining running state.
  assertLease(options.backgroundJobBoard, lease, execution);
  try {
    await deleteAndVerifySession(
      options,
      execution,
      lease,
      'cancel-task-after-abort',
    );
  } catch (error) {
    if (error instanceof LeaseOperationTimeoutError) throw error;
    // A confirmed native abort or an explicit not-found response is already
    // terminal evidence. A transport/unknown abort failure is not evidence;
    // in that case a failed delete must remain uncertain as well.
    if (abortConfirmed) return;
    throw error;
  }
}

async function deleteAndVerifySession(
  options: CancelTaskToolOptions,
  execution: { taskID: string; generation: number },
  lease: BackgroundJobLease,
  reason: string,
): Promise<void> {
  const taskID = execution.taskID;
  const client = getClient(options.input);

  assertLease(options.backgroundJobBoard, lease, execution);
  log('[cancel-task] deleting session after abort attempt', {
    taskID,
    reason,
  });
  try {
    const response = await awaitLeaseOperation(
      options.backgroundJobBoard,
      lease,
      () =>
        client.session.delete({
          path: { id: taskID },
          query: { directory: options.input.directory },
        }),
      options.deleteTimeoutMs ?? 10_000,
      `Session delete timed out after ${options.deleteTimeoutMs ?? 10_000}ms`,
    );
    assertLease(options.backgroundJobBoard, lease, execution);
    const responseError = operationError(response);
    if (responseError !== undefined) throw responseError;
    const responseData = operationBoolean(response);
    if (responseData === false) {
      throw new Error(`Session delete was not confirmed: ${taskID}`);
    }
    log('[cancel-task] session delete returned', { taskID, reason });
  } catch (error) {
    if (error instanceof LeaseOperationTimeoutError) throw error;
    assertLease(options.backgroundJobBoard, lease, execution);
    if (isExplicitSessionAbsence(error)) {
      log('[cancel-task] session delete confirmed missing/deleted', {
        taskID,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    log('[cancel-task] session delete failed; verifying live state', {
      taskID,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    const status = await getSessionStatus(
      options.input,
      taskID,
      options.deleteVerifyMs ?? 1_500,
      lease,
      options.backgroundJobBoard,
    );
    assertLease(options.backgroundJobBoard, lease, execution);
    log('[cancel-task] delete failure verification status', {
      taskID,
      reason,
      status: status.status,
      statusSource: status.source,
      statusKeys: status.keys,
    });
    if (status.status === 'busy' || status.status === 'retry') {
      throw new SessionStillRunningError(
        `Session delete failed and task is still busy: ${taskID}`,
      );
    }
    // An idle or missing status entry is only a liveness observation. It does
    // not prove that a failed delete or abort reached the server, so preserve
    // the operation error and let the caller expose an uncertain/error state.
    throw error;
  }

  const deadline = Date.now() + (options.deleteVerifyMs ?? 1_500);
  const stableStoppedMs = options.deleteStableStoppedMs ?? 300;
  const retryIntervalMs = options.abortRetryIntervalMs ?? 150;
  let stableStoppedSince: number | undefined;
  let attempts = 0;
  let lastStatus: string | undefined;
  while (Date.now() <= deadline) {
    attempts += 1;
    assertLease(options.backgroundJobBoard, lease, execution);
    const status = await getSessionStatus(
      options.input,
      taskID,
      Math.max(1, deadline - Date.now()),
      lease,
      options.backgroundJobBoard,
    );
    assertLease(options.backgroundJobBoard, lease, execution);
    lastStatus = status.status;
    log('[cancel-task] delete verification status', {
      taskID,
      reason,
      attempts,
      status: status.status,
      statusSource: status.source,
      statusKeys: status.keys,
      stableStoppedSince,
    });
    const quiescent =
      status.status === 'idle' || status.source === 'missing-from-map';
    if (!quiescent) {
      stableStoppedSince = undefined;
      await delay(retryIntervalMs);
      assertLease(options.backgroundJobBoard, lease, execution);
      continue;
    }
    stableStoppedSince ??= Date.now();
    if (Date.now() - stableStoppedSince >= stableStoppedMs) return;
    await delay(retryIntervalMs);
    assertLease(options.backgroundJobBoard, lease, execution);
  }

  throw new SessionStillRunningError(
    `Session delete returned but task did not stay stopped: ${taskID} (${lastStatus ?? 'unknown'})`,
  );
}

async function getSessionStatus(
  input: PluginInput,
  taskID: string,
  timeoutMs?: number,
  lease?: BackgroundJobLease,
  backgroundJobBoard?: BackgroundJobStore,
): Promise<{
  status: string | undefined;
  source: string;
  keys: string[];
}> {
  if (!lease || !backgroundJobBoard) {
    throw new LeaseOwnershipLostError(
      `Session status lookup requires a live cancellation lease: ${taskID}`,
    );
  }
  assertLease(backgroundJobBoard, lease, {
    taskID: lease.taskID,
    generation: lease.generation,
  });

  let response: unknown;
  try {
    response = await awaitLeaseOperation(
      backgroundJobBoard,
      lease,
      () =>
        getClient(input).session.status({
          query: { directory: input.directory },
        }),
      Math.max(1, timeoutMs ?? 5_000),
      `Session status lookup timed out after ${Math.max(1, timeoutMs ?? 5_000)}ms`,
    );
  } catch (error) {
    if (error instanceof LeaseOperationTimeoutError) throw error;
    if (error instanceof LeaseOwnershipLostError) throw error;
    return {
      status: undefined,
      source: 'lookup-error',
      keys: [],
    };
  }
  assertLease(backgroundJobBoard, lease, {
    taskID: lease.taskID,
    generation: lease.generation,
  });

  const data = isRecord(response) ? response.data : undefined;
  if (
    !isRecord(data) ||
    Object.hasOwn(data, 'type') ||
    Object.hasOwn(data, 'status')
  ) {
    return { status: undefined, source: 'lookup-error', keys: [] };
  }

  const statuses = new Map<string, 'busy' | 'retry' | 'idle'>();
  const malformedSessionIDs = new Set<string>();
  for (const [sessionID, value] of Object.entries(data)) {
    if (
      isRecord(value) &&
      (value.type === 'busy' || value.type === 'retry' || value.type === 'idle')
    ) {
      statuses.set(sessionID, value.type);
    } else {
      malformedSessionIDs.add(sessionID);
    }
  }
  return {
    status: malformedSessionIDs.has(taskID) ? undefined : statuses.get(taskID),
    source: malformedSessionIDs.has(taskID)
      ? 'malformed-entry'
      : statuses.has(taskID)
        ? 'task-map-entry'
        : 'missing-from-map',
    keys: [...statuses.keys()].slice(0, 20),
  };
}

function assertLease(
  backgroundJobBoard: BackgroundJobStore,
  lease: BackgroundJobLease,
  execution: { taskID: string; generation: number },
): void {
  if (
    lease.taskID !== execution.taskID ||
    lease.generation !== execution.generation ||
    lease.kind !== 'cancellation' ||
    !backgroundJobBoard.validateLease(lease)
  ) {
    throw new LeaseOwnershipLostError(
      `Cancellation lease is no longer valid for ${execution.taskID} generation ${execution.generation}`,
    );
  }
}

async function awaitLeaseOperation<T>(
  backgroundJobBoard: BackgroundJobStore,
  lease: BackgroundJobLease,
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timedOut = false;
  let settled = false;
  const underlying = Promise.resolve().then(operation);
  const tracked = underlying.then(
    (value) => {
      settled = true;
      if (timedOut) backgroundJobBoard.releaseLease(lease);
      return value;
    },
    (error: unknown) => {
      settled = true;
      if (timedOut) backgroundJobBoard.releaseLease(lease);
      throw error;
    },
  );

  try {
    return await withTimeout(tracked, timeoutMs, message);
  } catch (error) {
    if (!(error instanceof OperationTimeoutError)) throw error;
    timedOut = true;
    const pending = !settled;
    if (!pending) backgroundJobBoard.releaseLease(lease);
    throw new LeaseOperationTimeoutError(error.message, pending);
  }
}

function operationError(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  const error = response.error;
  return error === undefined || error === null ? undefined : error;
}

function operationBoolean(response: unknown): boolean | undefined {
  if (response === true || response === false) return response;
  if (!isRecord(response)) return undefined;
  return typeof response.data === 'boolean' ? response.data : undefined;
}

function isExplicitSessionAbsence(error: unknown): boolean {
  const statusCode = findStatusCode(error);
  if (statusCode === 404) return true;

  const text = errorText(error);
  return /\b(?:not[\s_-]?found(?:error)?|no such (?:session|resource)|does not exist|already[\s_-]?deleted|session[\s_-]?deleted)\b/i.test(
    text,
  );
}

function findStatusCode(value: unknown, depth = 0): number | undefined {
  if (depth > 3 || !isRecord(value)) return undefined;
  for (const key of ['statusCode', 'status']) {
    const candidate = value[key];
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
      return Number(candidate);
    }
  }
  return (
    findStatusCode(value.data, depth + 1) ??
    findStatusCode(value.cause, depth + 1)
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function getSessionParentID(
  input: PluginInput,
  taskID: string,
): Promise<string | undefined> {
  try {
    const response = await getClient(input).session.get({
      path: { id: taskID },
      query: { directory: input.directory },
    });
    const session = response.data;
    if (!session) return undefined;
    return session.parentID;
  } catch (error) {
    log('[cancel-task] session metadata lookup failed', {
      taskID,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function unknownTaskOutput(taskID: string, message: string): string {
  return [
    `task_id: ${taskID}`,
    'state: unknown',
    '',
    '<task_error>',
    message,
    '</task_error>',
  ].join('\n');
}

function isCapturedExecution(
  record: ReturnType<BackgroundJobStore['get']>,
  capturedExecution: { taskID: string; generation: number },
): boolean {
  return (
    record?.taskID === capturedExecution.taskID &&
    record.generation === capturedExecution.generation
  );
}

function staleCancellationOutput(
  options: CancelTaskToolOptions,
  capturedExecution: { taskID: string; generation: number },
  detail?: string,
): string {
  const current = options.backgroundJobBoard.get(capturedExecution.taskID);
  const message = detail
    ? `stale/uncertain cancellation: ${detail}`
    : current
      ? `stale/uncertain cancellation: ${capturedExecution.taskID} changed from generation ${capturedExecution.generation} to generation ${current.generation}; the newer execution was not cancelled`
      : `stale/uncertain cancellation: ${capturedExecution.taskID} is no longer tracked; generation ${capturedExecution.generation} was not cancelled`;
  log('[cancel-task] refusing stale cancellation terminal transition', {
    taskID: capturedExecution.taskID,
    capturedGeneration: capturedExecution.generation,
    currentGeneration: current?.generation,
    currentState: current?.state,
  });
  return [
    `task_id: ${capturedExecution.taskID}`,
    `state: ${current?.state ?? 'unknown'}`,
    '',
    '<task_error>',
    message,
    '</task_error>',
  ].join('\n');
}
