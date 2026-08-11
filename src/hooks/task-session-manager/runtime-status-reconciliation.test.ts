import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';

function createReconciler(
  status: () => Promise<unknown>,
  statusTimeoutMs?: number,
) {
  const board = new BackgroundJobBoard();
  const contextFilesForPrompt = mock(() => []);
  const prune = mock(() => {});
  const reconciler = createRuntimeStatusReconciler({
    input: {
      directory: '/test/project',
      client: { session: { status } },
    } as never,
    backgroundJobBoard: board,
    statusTimeoutMs,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(['child-1']),
      contextFilesForPrompt,
      prune,
    },
  });
  board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'fix reconciliation',
    now: 0,
  });
  return { board, reconciler, contextFilesForPrompt, prune };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error('Deferred promise resolver is unavailable');
      resolve(value);
    },
  };
}

describe('runtime status reconciliation', () => {
  test('keeps a runtime-busy job running', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'busy' } },
    }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
  });

  test('marks an absent runtime session stopped instead of completed', async () => {
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(async () => ({ data: {} }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
      resultSummary:
        'Background session stopped before a terminal task result was received.',
    });
    expect(board.resolveReusable('parent-1', 'fix-1', 'fixer')).toBeUndefined();
    expect(contextFilesForPrompt).toHaveBeenCalledWith('child-1');
    expect(prune).toHaveBeenCalledWith(board);
  });

  test('keeps the board running but explicitly uncertain when lookup fails', async () => {
    const { board, reconciler } = createReconciler(async () => {
      throw new Error('server restarting');
    });

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError: 'Runtime status lookup failed: server restarting',
    });
  });

  test('marks malformed runtime status entries uncertain rather than stopped', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'suspended' } },
    }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a recognized session state.',
    });
  });

  test.each([
    { type: 'idle' },
    { type: 'suspended' },
    { status: { type: 'busy' } },
  ])('marks unsupported status wrapper %j uncertain', async (data) => {
    const { board, reconciler } = createReconciler(async () => ({ data }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
  });

  test('turns a hung status lookup into uncertainty instead of stalling', async () => {
    const { board, reconciler } = createReconciler(
      () => new Promise(() => {}),
      1,
    );

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status lookup failed: Session status lookup timed out',
    });
  });

  test('does not stop a job that received busy while status lookup was in flight', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.markRunningFromLiveSession('child-1');
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('does not apply an old status response to a relaunched generation', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'relaunched fix',
      now: 1,
    });
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      description: 'relaunched fix',
      generation: 2,
    });
  });

  test('allows runtime busy to revive an acknowledged stopped job', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    const generation = board.get('child-1')?.generation;
    board.markStopped('child-1', 'no result', 1, generation);
    board.markReconciled('child-1');

    board.markRunningFromLiveSession('child-1', 2, generation);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      resultSummary: undefined,
    });
  });

  test('keeps a timed-out job recoverable through repeated busy observations', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    board.updateStatus({
      taskID: 'child-1',
      state: 'running',
      timedOut: true,
    });

    board.markRunningFromLiveSession('child-1', 1);
    board.markRunningFromLiveSession('child-1', 2);

    expect(
      board.resolveRecoverable('parent-1', 'fix-1', 'fixer'),
    ).toBeDefined();
  });

  test('does not mutate after disposal while a lookup is in flight', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    reconciler.dispose();
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });
});
