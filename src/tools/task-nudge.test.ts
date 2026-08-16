import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createTaskNudgeTool } from './task-nudge';

let client: Record<string, any>;
mock.module('../utils/opencode-client', () => ({ getClient: () => client }));

function registerStuckChild(
  board: BackgroundJobBoard,
  taskID = 'ses_child1',
  parent = 'parent-1',
): void {
  board.registerLaunch({
    taskID,
    parentSessionID: parent,
    agent: 'fixer',
    description: 'implement',
    now: 0,
  });
}

function busyClient(promptCalls: Array<() => Promise<unknown>> = []): void {
  client = {
    session: {
      status: mock(async () => ({
        data: { ses_child1: { type: 'busy' } },
      })),
      prompt: mock(async () => {
        const next = promptCalls.shift();
        if (next) return next();
        return {};
      }),
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('task_nudge', () => {
  test('admits a parent-owned live, possibly-stuck child via noReply without resuming it', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });
    await expect(
      task_nudge.execute(
        { task_id: 'ses_child1', message: 'Please continue.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).resolves.toContain('without resuming');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith({
      path: { id: 'ses_child1' },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: 'Please continue.' }],
      },
    });
    // The mocked client exposes no resume/promptAsync channel at all, so an
    // admitted nudge can only have used the noReply prompt path.
    expect((client.session as any).promptAsync).toBeUndefined();
  });

  test('rejects a second nudge within the 30s window', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'First' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('without resuming');
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Second' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('nudged recently');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('concurrent nudges admit exactly one (atomic rate-limit reservation)', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });
    const results = await Promise.allSettled([
      task_nudge.execute({ task_id: 'ses_child1', message: 'First' }, {
        sessionID: 'parent-1',
      } as any),
      task_nudge.execute({ task_id: 'ses_child1', message: 'Second' }, {
        sessionID: 'parent-1',
      } as any),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason?.message).toContain(
      'nudged recently',
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('refuses to nudge an active child that is not possibly stuck', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 10_000, // idle for 10s: active, not possibly stuck
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Nudge' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('not possibly stuck');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('refuses to nudge when the live status read fails', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    client = {
      session: {
        status: mock(async () => {
          throw new Error('host status read failed');
        }),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Nudge' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('live status unavailable');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('refuses to nudge an absent child session as unknown', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    client = { session: { status: mock(async () => ({ data: {} })), prompt } };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Nudge' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('child session status unknown');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('keeps malformed live status distinct from an absent session', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'suspended' } },
        })),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Nudge' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('child session status malformed');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('refuses to nudge a board-terminal task', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'completed',
      resultSummary: 'done',
    });
    const prompt = mock(async () => ({}));
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Nudge' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('board state is completed, not running');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('does not prompt after the task completes during live status lookup', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    const statusResult = deferred<{ data: Record<string, unknown> }>();
    const status = mock(async () => statusResult.promise);
    client = { session: { status, prompt } };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    const pending = task_nudge.execute(
      { task_id: 'ses_child1', message: 'Nudge' },
      { sessionID: 'parent-1' } as any,
    );
    await Promise.resolve();
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'completed',
      resultSummary: 'done',
    });
    statusResult.resolve({ data: { ses_child1: { type: 'busy' } } });

    await expect(pending).rejects.toThrow(
      'board state is completed, not running',
    );
    expect(status).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  test('does not prompt after the task is deleted during live status lookup', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    const statusResult = deferred<{ data: Record<string, unknown> }>();
    const status = mock(async () => statusResult.promise);
    client = { session: { status, prompt } };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    const pending = task_nudge.execute(
      { task_id: 'ses_child1', message: 'Nudge' },
      { sessionID: 'parent-1' } as any,
    );
    await Promise.resolve();
    board.drop('ses_child1');
    statusResult.resolve({ data: { ses_child1: { type: 'busy' } } });

    await expect(pending).rejects.toThrow('no longer tracked');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('does not prompt an old generation after relaunch during live status lookup', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    const statusResult = deferred<{ data: Record<string, unknown> }>();
    const status = mock(async () => statusResult.promise);
    client = { session: { status, prompt } };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    const pending = task_nudge.execute(
      { task_id: 'ses_child1', message: 'Nudge' },
      { sessionID: 'parent-1' } as any,
    );
    await Promise.resolve();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 121_000,
    });
    statusResult.resolve({ data: { ses_child1: { type: 'busy' } } });

    await expect(pending).rejects.toThrow('run generation changed');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('does not prompt when relaunch happens while acquiring the prompt boundary', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const prompt = mock(async () => ({}));
    let promptPropertyRead = false;
    const session = {
      status: mock(async () => ({
        data: { ses_child1: { type: 'busy' } },
      })),
      get prompt() {
        if (!promptPropertyRead) {
          promptPropertyRead = true;
          board.registerLaunch({
            taskID: 'ses_child1',
            parentSessionID: 'parent-1',
            agent: 'fixer',
            now: 121_000,
          });
        }
        return prompt;
      },
    };
    client = { session };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Nudge' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('run generation changed');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('rejects a task id owned by a different parent', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => 120_000,
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Nudge' }, {
        sessionID: 'parent-2',
      } as any),
    ).rejects.toThrow('Unknown task ID or alias');
  });

  test('rolls back the rate-limit reservation when the prompt fails', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    let nowValue = 120_000;
    let failPrompt = true;
    const prompt = mock(async () => {
      if (failPrompt) throw new Error('prompt transport failed');
      return {};
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
        prompt,
      },
    };
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => nowValue,
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'First' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('prompt transport failed');
    // A failed nudge must not lock the task out: advance 1s and retry.
    nowValue = 121_000;
    failPrompt = false;
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Second' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('without resuming');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  test('allows a second nudge after the 30s window elapses', async () => {
    const board = new BackgroundJobBoard();
    registerStuckChild(board);
    let nowValue = 120_000;
    busyClient();
    const { task_nudge } = createTaskNudgeTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
      now: () => nowValue,
    });
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'First' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('without resuming');
    nowValue = 150_000;
    await expect(
      task_nudge.execute({ task_id: 'ses_child1', message: 'Second' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('without resuming');
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });
});
