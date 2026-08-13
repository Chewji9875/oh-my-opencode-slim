import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { buildPluginInput } from '../v2/client-shim';
import { createTaskResultTool } from './task-result';

let mockClient: Record<string, any>;

mock.module('../utils/opencode-client', () => ({
  getClient: () => mockClient,
}));

function createTool() {
  const board = new BackgroundJobBoard();
  const get = mock(async () => ({ data: { parentID: 'parent-1' } }));
  const messages = mock(async () => ({
    data: [
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'private work' },
          { type: 'text', text: 'complete findings' },
        ],
      },
    ],
  }));
  const status = mock(async () => ({ data: {} }));
  mockClient = { session: { get, messages, status } };

  const tools = createTaskResultTool({
    input: { directory: '/test/project' } as any,
    backgroundJobBoard: board,
  });
  return { board, get, messages, tool: tools.task_result };
}

describe('task_result', () => {
  test('returns completed task text without prompting the child', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({ taskID: 'ses_child1', state: 'completed' });

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe('complete findings');
    expect(messages).toHaveBeenCalledTimes(1);
    expect(mockClient.session.prompt).toBeUndefined();
    expect(mockClient.session.promptAsync).toBeUndefined();
  });

  test('returns only the final assistant response', async () => {
    const { board, tool } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'earlier progress' }],
        },
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'final findings' }],
        },
      ],
    });

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'fixer',
      } as any),
    ).resolves.toBe('final findings');
  });

  test('rejects a still-running tracked task', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('still running');
    expect(messages).not.toHaveBeenCalled();
  });

  test('rejects an untracked child whose live session is busy', async () => {
    const { tool, messages } = createTool();
    mockClient.session.status.mockImplementation(async () => ({
      data: { ses_child1: { type: 'busy' } },
    }));

    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('still running');
    expect(messages).not.toHaveBeenCalled();
  });

  test('rejects an untracked child whose live session is retrying', async () => {
    const { tool, messages } = createTool();
    mockClient.session.status.mockImplementation(async () => ({
      data: { ses_child1: { type: 'retry' } },
    }));

    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('still running');
    expect(messages).not.toHaveBeenCalled();
  });

  test('returns a tracked result through the v2 client shim', async () => {
    const { board, tool } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'completed',
      resultSummary: 'complete findings',
    });
    mockClient = (buildPluginInput('/test/project') as { client: never })
      .client;

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe('complete findings');
  });

  test('rejects a task owned by another parent session', async () => {
    const { tool, get, messages } = createTool();
    get.mockImplementation(async () => ({
      data: { parentID: 'other-parent' },
    }));

    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('does not belong to this session');
    expect(messages).not.toHaveBeenCalled();
  });
});
