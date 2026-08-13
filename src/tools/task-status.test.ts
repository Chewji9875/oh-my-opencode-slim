import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createTaskStatusTool } from './task-status';

let client: Record<string, any>;
mock.module('../utils/opencode-client', () => ({ getClient: () => client }));

describe('task_status', () => {
  test('reads a child status without prompting it', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const status = mock(async () => ({ data: { ses_child1: { type: 'busy' } } }));
    client = { session: { status } };
    const { task_status } = createTaskStatusTool({
      input: { directory: '/test' } as any,
      backgroundJobBoard: board,
    });

    await expect(
      task_status.execute({ task_id: 'ses_child1' }, { sessionID: 'parent-1' } as any),
    ).resolves.toContain('state: busy');
    expect(status).toHaveBeenCalledTimes(1);
  });

  test('flags a busy child without recent activity as possibly stuck', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({ taskID: 'ses_child1', parentSessionID: 'parent-1', agent: 'fixer', description: 'implement', now: 0 });
    client = { session: { status: mock(async () => ({ data: { ses_child1: { type: 'busy' } } })) } };
    const { task_status } = createTaskStatusTool({ input: { directory: '/test' } as any, backgroundJobBoard: board, now: () => 120_000 });
    await expect(task_status.execute({ task_id: 'ses_child1' }, { sessionID: 'parent-1' } as any)).resolves.toContain('possibly_stuck: true');
  });
});
