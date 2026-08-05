import { describe, expect, test } from 'bun:test';
import { createDesignerAgent } from './designer';
import { createFixerAgent } from './fixer';
import {
  buildOrchestratorPrompt,
  createOrchestratorAgent,
} from './orchestrator';

describe('verification ownership prompt contracts', () => {
  test('orchestrator assigns ownership and limits final-state verification', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('bounded contract');
    expect(prompt).toContain('write scope');
    expect(prompt).toContain('observable success claims');
    expect(prompt).toContain('validation owner');
    expect(prompt).toContain('maximum validation scope');
    expect(prompt).toContain('exactly one owner');
    expect(prompt).toContain(
      'Reconcile all writer lanes before entering final-state',
    );
    expect(prompt).toContain('smallest orthogonal set of checks');
    expect(prompt).toContain('Reuse reported evidence only while it applies');
    expect(prompt).toContain('stale, failing, or ambiguous evidence');
    expect(prompt).toContain('Do not automatically dispatch review lanes');
    expect(prompt).toContain('A skipped check is not a passed check');
  });

  test('fixer limits validation to its assigned claim and scope', () => {
    const prompt = createFixerAgent('test/model').config.prompt as string;

    expect(prompt).toContain(
      'only when the Orchestrator explicitly assigns it',
    );
    expect(prompt).toContain('success claim');
    expect(prompt).toContain('maximum validation scope');
    expect(prompt).toContain('broad lint, typecheck, build, full-test');
    expect(prompt).toContain('exact command, result, and limitation');
    expect(prompt).toMatch(/skipped is not\s+passed/);
    expect(prompt).toContain('Skipped: no validation assigned');
    expect(prompt).toContain('reviewer work');
  });

  test('designer preserves user-visible validation ownership', () => {
    const prompt = createDesignerAgent('test/model').config.prompt as string;

    expect(prompt).toContain(
      'only when the Orchestrator explicitly assigns it',
    );
    expect(prompt).toContain('success claim');
    expect(prompt).toContain('maximum validation scope');
    expect(prompt).toContain('user-visible behavior');
    expect(prompt).toContain('visual hierarchy');
    expect(prompt).toContain('exact route, viewport,');
    expect(prompt).toContain('interaction steps');
    expect(prompt).toContain('exact command, result, and limitation');
    expect(prompt).toMatch(/skipped is not\s+passed/);
  });

  test('specialist overrides retain replacement and append semantics', () => {
    const fixerReplacement = createFixerAgent(
      'test/model',
      'replacement fixer prompt',
      'ignored fixer append',
    );
    const fixerAppend = createFixerAgent(
      'test/model',
      undefined,
      'fixer append prompt',
    );
    const designerReplacement = createDesignerAgent(
      'test/model',
      'replacement designer prompt',
      'ignored designer append',
    );
    const designerAppend = createDesignerAgent(
      'test/model',
      undefined,
      'designer append prompt',
    );

    expect(fixerReplacement.config.prompt).toBe('replacement fixer prompt');
    expect(fixerAppend.config.prompt).toEndWith('fixer append prompt');
    expect(designerReplacement.config.prompt).toBe(
      'replacement designer prompt',
    );
    expect(designerAppend.config.prompt).toEndWith('designer append prompt');
  });

  test('orchestrator overrides retain replacement and append semantics', () => {
    const replacement = createOrchestratorAgent(
      'test/model',
      'replacement orchestrator prompt',
      'orchestrator append prompt',
    );
    const appended = createOrchestratorAgent(
      'test/model',
      undefined,
      'orchestrator append prompt',
    );

    expect(replacement.config.prompt).toBe(
      'replacement orchestrator prompt\n\norchestrator append prompt',
    );
    expect(appended.config.prompt).toEndWith('orchestrator append prompt');
  });
});
