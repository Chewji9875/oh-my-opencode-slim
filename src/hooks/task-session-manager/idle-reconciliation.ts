import type { BackgroundJobStore, ContextFile } from '../../utils';
import { log } from '../../utils/logger';

export function createIdleReconciler(options: {
  backgroundJobBoard: BackgroundJobStore;
  evaluateContinuation: (
    parentSessionID: string,
    sessionToken: symbol,
  ) => Promise<void>;
  reconcileInjectedTerminalJobs: (parentSessionID: string) => void;
  idleReconcileDelayMs: number;
  isFallbackInProgress?: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  getContinuationSessionToken: (sessionID: string) => symbol;
  isCurrentContinuation: (
    sessionID: string,
    sessionToken: symbol,
    evaluationToken?: symbol,
  ) => boolean;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
}) {
  const idleReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const childIdleReconcileTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  function scheduleIdleReconciliation(parentSessionID: string): void {
    if (
      idleReconcileTimers.has(parentSessionID) ||
      options.hasInputWait(parentSessionID) ||
      options.isFallbackInProgress?.(parentSessionID)
    ) {
      return;
    }
    const sessionToken = options.getContinuationSessionToken(parentSessionID);
    const timer = setTimeout(() => {
      idleReconcileTimers.delete(parentSessionID);
      if (!options.isCurrentContinuation(parentSessionID, sessionToken)) {
        return;
      }
      options.reconcileInjectedTerminalJobs(parentSessionID);
      void options.evaluateContinuation(parentSessionID, sessionToken);
    }, options.idleReconcileDelayMs).unref?.();
    idleReconcileTimers.set(parentSessionID, timer);
  }

  function scheduleChildIdleReconciliation(
    sessionID: string,
    idleObservedAt: number,
  ): void {
    if (childIdleReconcileTimers.has(sessionID)) return;
    if (options.isFallbackInProgress?.(sessionID)) return;

    const timer = setTimeout(() => {
      childIdleReconcileTimers.delete(sessionID);
      if (options.isFallbackInProgress?.(sessionID)) return;

      const job = options.backgroundJobBoard.get(sessionID);
      if (job?.state !== 'running') return;

      // Busy after the idle means the session recovered (e.g. FG re-prompt).
      if (
        job.lastLiveBusyAt !== undefined &&
        job.lastLiveBusyAt > idleObservedAt
      ) {
        return;
      }

      log('[task-session-manager] reconciled running job from idle', {
        sessionID,
        alias: job.alias,
        parentSessionID: job.parentSessionID,
      });
      options.backgroundJobBoard.updateStatus({
        taskID: sessionID,
        state: 'completed',
        resultSummary: 'Background task completed (reconciled from idle event)',
      });
      options.backgroundJobBoard.markReconciled(sessionID);
      options.taskContextTracker.pendingManagedTaskIds.delete(sessionID);
      options.backgroundJobBoard.addContext(
        sessionID,
        options.taskContextTracker.contextFilesForPrompt(sessionID),
      );
      options.taskContextTracker.prune(options.backgroundJobBoard);
    }, options.idleReconcileDelayMs).unref?.();
    childIdleReconcileTimers.set(sessionID, timer);
  }

  function clearIdleTimers(sessionID: string): void {
    const pendingChildIdle = childIdleReconcileTimers.get(sessionID);
    if (pendingChildIdle) {
      clearTimeout(pendingChildIdle);
      childIdleReconcileTimers.delete(sessionID);
    }
    const pendingIdle = idleReconcileTimers.get(sessionID);
    if (pendingIdle) {
      clearTimeout(pendingIdle);
      idleReconcileTimers.delete(sessionID);
    }
  }

  /**
   * Clears all timers and returns the session IDs that had
   * idle-reconcile timers (used by server.instance.disposed).
   */
  function clearAllTimers(): string[] {
    for (const timer of childIdleReconcileTimers.values()) {
      clearTimeout(timer);
    }
    childIdleReconcileTimers.clear();

    const idleSessionIds = [...idleReconcileTimers.keys()];
    for (const timer of idleReconcileTimers.values()) {
      clearTimeout(timer);
    }
    idleReconcileTimers.clear();

    return idleSessionIds;
  }

  return {
    scheduleIdleReconciliation,
    scheduleChildIdleReconciliation,
    clearIdleTimers,
    clearAllTimers,
    /** Callback for continuation-token-manager's onInvalidateContinuation. */
    onInvalidateContinuation: (sessionID: string) => {
      const timer = idleReconcileTimers.get(sessionID);
      if (timer) {
        clearTimeout(timer);
        idleReconcileTimers.delete(sessionID);
      }
    },
  };
}
