import { describe, expect, test } from 'bun:test';
import { createDesignerAgent } from './designer';
import { createFixerAgent } from './fixer';
import { buildOrchestratorPrompt } from './orchestrator';

describe('verification ownership prompt contracts', () => {
  test('orchestrator assigns validation ownership and scope', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain(
      'Every delegation names a validation owner and allowed scope',
    );
    expect(prompt).toContain(
      'Reconcile all writer lanes before final validation',
    );
    expect(prompt).toContain(
      'Reuse still-valid evidence; do not repeat it unless the final state changed',
    );
    expect(prompt).toContain('an explicit requirement demands it');
  });

  test('fixer runs and reports only assigned validation', () => {
    const prompt = createFixerAgent('test/model').config.prompt as string;

    expect(prompt).toContain(
      'Run only validation assigned by the Orchestrator; do not broaden it',
    );
    expect(prompt).toContain('Report validation results and skips accurately');
  });

  test('designer runs and reports only assigned user-visible validation', () => {
    const prompt = createDesignerAgent('test/model').config.prompt as string;

    expect(prompt).toContain(
      'Run only validation assigned by the Orchestrator; do not broaden it',
    );
    expect(prompt).toContain('Report validation results and skips accurately');
    expect(prompt).toContain('Assigned validation should be user-visible');
  });
});
