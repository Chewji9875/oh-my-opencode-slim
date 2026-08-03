import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _testConfig,
  readSecondaryModelFromConfig,
  runSecondaryModelWithFallback,
} from './secondary-model';
import type { SecondaryModel } from './types';

type PromptStep = {
  text?: string;
  error?: Error;
};

function createMockClient(
  steps: PromptStep[],
  deleteBehavior?: {
    failTimes?: number;
  },
) {
  let createCount = 0;
  let promptCount = 0;
  let deleteCallCount = 0;
  const failTimes = deleteBehavior?.failTimes ?? 0;

  return {
    session: {
      create: mock(async () => ({ id: `session-${createCount++}` })),
      prompt: mock(async () => {
        const step = steps[promptCount++] ?? {};
        if (step.error) {
          throw step.error;
        }
        return {
          data: {
            parts: [{ type: 'text', text: step.text ?? '' }],
          },
        };
      }),
      delete: mock(async () => {
        deleteCallCount++;
        if (deleteCallCount <= failTimes) {
          throw new Error('delete failed');
        }
        return {};
      }),
    },
    tool: {
      ids: mock(async () => ({ data: ['read', 'bash'] })),
    },
  } as any;
}

describe('smartfetch/secondary-model', () => {
  const models: SecondaryModel[] = [
    { providerID: 'provider-a', modelID: 'small' },
    { providerID: 'provider-b', modelID: 'fallback' },
  ];

  afterEach(() => {
    mock.restore();
  });

  test('gives dedicated webfetch models precedence over fallback sources', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartfetch-test-'));
    const projectConfigDir = path.join(tempDir, '.opencode');
    const userConfigDir = path.join(tempDir, 'user-config');
    const originalEnv = { ...process.env };

    try {
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.mkdirSync(path.join(userConfigDir, 'opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'opencode.json'),
        JSON.stringify({ small_model: 'small/provider-model' }),
      );
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          agents: {
            explorer: { model: 'explorer/provider-model' },
            librarian: { model: 'librarian/provider-model' },
          },
        }),
      );
      delete process.env.OPENCODE_CONFIG_DIR;
      process.env.XDG_CONFIG_HOME = userConfigDir;

      await expect(
        readSecondaryModelFromConfig(tempDir, [
          { id: 'dedicated/provider-model', variant: 'fast' },
        ]),
      ).resolves.toEqual([
        {
          providerID: 'dedicated',
          modelID: 'provider-model',
          variant: 'fast',
        },
        { providerID: 'small', modelID: 'provider-model' },
        { providerID: 'explorer', modelID: 'provider-model' },
        { providerID: 'librarian', modelID: 'provider-model' },
      ]);
    } finally {
      process.env = originalEnv;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('falls back when the first model returns empty text', async () => {
    const client = createMockClient([
      { text: '   ' },
      { text: 'Useful answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      client,
      '/tmp/project',
      models,
      'Summarize the page',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Useful answer');
    expect(result.model).toEqual(models[1]);
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    expect(client.session.delete).toHaveBeenCalledTimes(2);
  });

  test('falls back when the first model throws', async () => {
    const client = createMockClient([
      { error: new Error('primary failed') },
      { text: 'Recovered answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      client,
      '/tmp/project',
      models,
      'Extract the answer',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Recovered answer');
    expect(result.model).toEqual(models[1]);
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    expect(client.session.delete).toHaveBeenCalledTimes(2);
  });

  test('retries session delete on transient failure', async () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    const originalDelay = _testConfig.deleteRetryDelayMs;
    _testConfig.deleteRetryDelayMs = 0;
    try {
      const client = createMockClient([{ text: 'Answer' }], { failTimes: 1 });

      const result = await runSecondaryModelWithFallback(
        client,
        '/tmp/project',
        [models[0]],
        'Summarize',
        'This is enough fetched content to clear the short-content guard.',
      );

      expect(result.text).toBe('Answer');
      // First attempt failed, second succeeded → 2 calls for one session
      expect(client.session.delete).toHaveBeenCalledTimes(2);
      expect(warnCalls.length).toBe(0);
    } finally {
      console.warn = originalWarn;
      _testConfig.deleteRetryDelayMs = originalDelay;
    }
  });

  test('logs warning when all delete retries fail but does not throw', async () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    const originalDelay = _testConfig.deleteRetryDelayMs;
    _testConfig.deleteRetryDelayMs = 0;
    try {
      const client = createMockClient([{ text: 'Answer' }], { failTimes: 99 });

      const result = await runSecondaryModelWithFallback(
        client,
        '/tmp/project',
        [models[0]],
        'Summarize',
        'This is enough fetched content to clear the short-content guard.',
      );

      // Secondary model still succeeds despite cleanup failure
      expect(result.text).toBe('Answer');
      expect(warnCalls.length).toBe(1);
      expect(String(warnCalls[0][0])).toContain('smartfetch');
    } finally {
      console.warn = originalWarn;
      _testConfig.deleteRetryDelayMs = originalDelay;
    }
  });

  test('falls back to next model when prompt times out', async () => {
    const client = {
      session: {
        create: mock(async () => ({ id: 'session-timeout' })),
        prompt: mock(async (opts: any) => {
          const model = opts.body.model;
          if (model.modelID === 'small') {
            throw new Error('Secondary model timed out');
          }
          return {
            data: {
              parts: [{ type: 'text', text: 'Fallback answer' }],
            },
          };
        }),
        delete: mock(async () => ({})),
      },
      tool: {
        ids: mock(async () => ({ data: ['read'] })),
      },
    } as any;

    const result = await runSecondaryModelWithFallback(
      client,
      '/tmp/project',
      models,
      'Summarize',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Fallback answer');
    expect(result.model).toEqual(models[1]);
  });
});
