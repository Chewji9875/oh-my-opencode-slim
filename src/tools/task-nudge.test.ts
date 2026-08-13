import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createTaskNudgeTool } from './task-nudge';

let client: Record<string, any>;
mock.module('../utils/opencode-client', () => ({ getClient: () => client }));

describe('task_nudge', () => {
  test('admits a parent-owned running child without resuming it', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({ taskID: 'ses_child1', parentSessionID: 'parent-1', agent: 'fixer', description: 'implement' });
    const prompt = mock(async () => ({}));
    client = { session: { prompt } };
    const { task_nudge } = createTaskNudgeTool({ input: { directory: '/test' } as any, backgroundJobBoard: board, now: () => 0 });
    await expect(task_nudge.execute({ task_id: 'ses_child1', message: 'Please continue.' }, { sessionID: 'parent-1' } as any)).resolves.toContain('without resuming');
    expect(prompt).toHaveBeenCalledWith({ path: { id: 'ses_child1' }, body: { noReply: true, parts: [{ type: 'text', text: 'Please continue.' }] } });
    await expect(task_nudge.execute({ task_id: 'ses_child1', message: 'Again' }, { sessionID: 'parent-1' } as any)).rejects.toThrow('nudged recently');
  });
});
