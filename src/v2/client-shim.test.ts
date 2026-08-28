import { describe, expect, test } from 'bun:test';
import { buildPluginInput } from './client-shim';
import type { V2Context } from './types';

function makeCtx(overrides?: Partial<V2Context['session']>): V2Context {
  return {
    app: { name: 'opencode2', version: 'test' },
    options: {},
    agent: {
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
      list: async () => [],
    },
    tool: {
      transform: async () => ({ dispose() {} }),
      hook: async () => ({ dispose() {} }),
    },
    command: {
      transform: async () => ({ dispose() {} }),
      list: async () => [],
    },
    session: {
      hook: async () => ({ dispose() {} }),
      ...overrides,
    },
    event: {
      subscribe() {
        return {} as never;
      },
    },
    location: {
      directory: '/proj',
      project: { id: 'proj_1', directory: '/proj', canonical: '/proj' },
    },
  } as never;
}

describe('v2 client shim delegation', () => {
  test('messages maps session.context to v1 {data} with info/parts', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        context: async (i: { sessionID: string }) => {
          calls.push(i);
          return [
            {
              id: 'm1',
              role: 'user',
              content: [{ type: 'text', text: 'hello' }],
            },
          ];
        },
      } as never),
    );
    const res = await (
      input.client as {
        session: {
          messages: (a: unknown) => Promise<{ data: unknown[] }>;
        };
      }
    ).session.messages({ path: { id: 'ses_1' } });
    expect(calls).toEqual([{ sessionID: 'ses_1' }]);
    expect(res.data).toEqual([
      {
        info: { id: 'm1', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]);
  });

  test('promptAsync switches model then steers when body.model present', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        switchModel: async (i: unknown) => {
          seq.push({ m: 'switchModel', i });
        },
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        agent: 'orchestrator',
        parts: [
          { type: 'text', text: 'retry me' },
          { type: 'text', synthetic: true, text: 'reminder' },
        ],
      },
    });
    expect(seq[0]).toMatchObject({
      m: 'switchModel',
      i: {
        sessionID: 'ses_1',
        model: { id: 'claude-x', providerID: 'anthropic' },
      },
    });
    expect(seq[1]).toMatchObject({
      m: 'prompt',
      i: {
        sessionID: 'ses_1',
        delivery: 'steer',
        text: expect.stringContaining('retry me'),
      },
    });
  });

  test('promptAsync without a body model prompts directly', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        switchModel: async (i: unknown) => {
          seq.push({ m: 'switchModel', i });
        },
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'plain steer' }] },
    });
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({
      m: 'prompt',
      i: { sessionID: 'ses_1', delivery: 'steer', text: 'plain steer' },
    });
  });

  test('abort delegates to interrupt', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        interrupt: async (i: unknown) => {
          calls.push(i);
          return { interrupted: true };
        },
      } as never),
    );
    await (
      input.client as {
        session: { abort: (a: unknown) => Promise<unknown> };
      }
    ).session.abort({ path: { id: 'ses_1' } });
    expect(calls).toEqual([{ sessionID: 'ses_1', continue: false }]);
  });

  test('get delegates to session.get and wraps into {data}', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        get: async (i: { sessionID: string }) => {
          calls.push(i);
          return { id: 'ses_1', parentID: 'ses_0', title: 't' };
        },
      } as never),
    );
    const res = await (
      input.client as {
        session: {
          get: (a: unknown) => Promise<{ data: unknown }>;
        };
      }
    ).session.get({ path: { id: 'ses_1' }, query: { directory: '/proj' } });
    expect(calls).toEqual([{ sessionID: 'ses_1' }]);
    expect(res.data).toEqual({ id: 'ses_1', parentID: 'ses_0', title: 't' });
  });

  test('unavailable methods fail explicitly, never fake success', async () => {
    const input = buildPluginInput(makeCtx({}));
    const session = (
      input.client as {
        session: {
          prompt: (a: unknown) => Promise<unknown>;
          promptAsync: (a: unknown) => Promise<unknown>;
        };
      }
    ).session;
    await expect(
      session.prompt({ path: { id: 's' }, body: { parts: [] } }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      session.promptAsync({ path: { id: 's' }, body: { parts: [] } }),
    ).rejects.toThrow(/unavailable/i);
  });

  test('hostFlavor, project, and directory come from location', () => {
    const input = buildPluginInput(makeCtx({}));
    expect(input.hostFlavor).toBe('v2');
    expect(input.project).toEqual({ id: 'proj_1', directory: '/proj' });
    expect(input.directory).toBe('/proj');
    expect(input.worktree).toBe('/proj');
    expect(input.serverUrl).toBeUndefined();
  });

  test('location falls back to cwd with a global project', () => {
    const ctx = makeCtx({});
    delete (ctx as { location?: unknown }).location;
    const input = buildPluginInput(ctx);
    expect(input.directory).toBe(process.cwd());
    expect(input.project).toEqual({
      id: 'global',
      directory: process.cwd(),
    });
  });

  test('preserves the Phase 1 generateText channel', async () => {
    const generateText = async (prompt: string) => ({ text: prompt });
    const input = buildPluginInput(makeCtx({}), { generateText });
    const channel = (
      input as {
        experimental_v2?: {
          generateText?: (p: string) => Promise<{ text: string }>;
        };
      }
    ).experimental_v2?.generateText;
    expect(typeof channel).toBe('function');
    expect(await channel?.('ping')).toEqual({ text: 'ping' });
  });

  test('omits experimental_v2 entirely without extras', () => {
    const input = buildPluginInput(makeCtx({}));
    expect('experimental_v2' in (input as Record<string, unknown>)).toBe(false);
  });
});
