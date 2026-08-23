import { beforeEach, describe, expect, test } from 'bun:test';
import type { ToolLoopGuardHook } from './hook';
import { createToolLoopGuardHook, LOOP_GUARD_WARNING } from './hook';

function beforeInput(
  overrides: Partial<{ tool: string; sessionID: string; callID: string }> = {},
) {
  return { tool: 'read', sessionID: 's1', callID: 'c1', ...overrides };
}

function afterInput(
  overrides: Partial<{ tool: string; sessionID: string; callID: string }> = {},
) {
  return { tool: 'read', sessionID: 's1', callID: 'c1', ...overrides };
}

describe('tool-loop-guard', () => {
  let hook: ToolLoopGuardHook;

  beforeEach(() => {
    hook = createToolLoopGuardHook();
  });

  async function runIdenticalCall(
    callID: string,
    args: unknown,
    toolOutput = '...file contents...',
  ) {
    await hook['tool.execute.before'](beforeInput({ callID }), { args });
    const output = { output: toolOutput, metadata: {} };
    await hook['tool.execute.after'](afterInput({ callID }), output);
    return output;
  }

  test('leaves output untouched for first and second identical calls', async () => {
    const o1 = await runIdenticalCall('c1', { filePath: 'a.ts' });
    const o2 = await runIdenticalCall('c2', { filePath: 'a.ts' });
    expect(o1.output).toBe('...file contents...');
    expect(o2.output).toBe('...file contents...');
  });

  test('appends warning on third identical consecutive call', async () => {
    await runIdenticalCall('c1', { filePath: 'a.ts' });
    await runIdenticalCall('c2', { filePath: 'a.ts' });
    const o3 = await runIdenticalCall('c3', { filePath: 'a.ts' });
    expect(o3.output).toContain(LOOP_GUARD_WARNING);
  });

  test('resets the count when arguments change', async () => {
    await runIdenticalCall('c1', { filePath: 'a.ts' });
    await runIdenticalCall('c2', { filePath: 'a.ts' });
    const o3 = await runIdenticalCall('c3', { filePath: 'b.ts' });
    expect(o3.output).toBe('...file contents...');
    const o4 = await runIdenticalCall('c4', { filePath: 'b.ts' });
    expect(o4.output).toBe('...file contents...');
  });

  test('key order in args does not defeat detection', async () => {
    await runIdenticalCall('c1', { filePath: 'a.ts', offset: 12 });
    await runIdenticalCall('c2', { offset: 12, filePath: 'a.ts' });
    const o3 = await runIdenticalCall('c3', { filePath: 'a.ts', offset: 12 });
    expect(o3.output).toContain(LOOP_GUARD_WARNING);
  });

  test('fifth identical call is refused in tool.execute.before', async () => {
    for (let i = 1; i <= 4; i++) {
      await runIdenticalCall(`c${i}`, { filePath: 'a.ts' });
    }
    await expect(
      hook['tool.execute.before'](beforeInput({ callID: 'c5' }), {
        args: { filePath: 'a.ts' },
      }),
    ).rejects.toThrow('infinite loop');
  });

  test('blocked fingerprint stays blocked', async () => {
    for (let i = 1; i <= 4; i++) {
      await runIdenticalCall(`c${i}`, { filePath: 'a.ts' });
    }
    await expect(
      hook['tool.execute.before'](beforeInput({ callID: 'c5' }), {
        args: { filePath: 'a.ts' },
      }),
    ).rejects.toThrow();
    await expect(
      hook['tool.execute.before'](beforeInput({ callID: 'c6' }), {
        args: { filePath: 'a.ts' },
      }),
    ).rejects.toThrow();
  });

  test('task tool is exempt', async () => {
    for (let i = 1; i <= 5; i++) {
      await hook['tool.execute.before'](
        beforeInput({ tool: 'task', callID: `t${i}` }),
        { args: { subagent_type: 'explorer', prompt: 'find x' } },
      );
    }
    // no throw
  });

  test('sessions are isolated', async () => {
    for (let i = 1; i <= 2; i++) {
      await runIdenticalCall(`a${i}`, { filePath: 'a.ts' });
    }
    // same args, different session: count starts fresh
    await hook['tool.execute.before'](
      beforeInput({ sessionID: 's2', callID: 'b1' }),
      { args: { filePath: 'a.ts' } },
    );
    const output = { output: '...file contents...', metadata: {} };
    await hook['tool.execute.after'](
      afterInput({ sessionID: 's2', callID: 'b1' }),
      output,
    );
    expect(output.output).toBe('...file contents...');
  });

  test('does not append marker twice', async () => {
    let out = { output: 'x' };
    for (let i = 1; i <= 4; i++) {
      out = await runIdenticalCall(`c${i}`, { filePath: 'a.ts' });
    }
    const count =
      String(out.output).split(LOOP_GUARD_WARNING.trim()).length - 1;
    expect(count).toBe(1);
  });
});
