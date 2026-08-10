import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InterviewSessionRuntime } from './runtime';
import { createInterviewService } from './service';
import type { InterviewMessage } from './types';

describe('interview finalization', () => {
  test('persists clean completion markdown without using stale interview state', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-finalization-');
    const messages: InterviewMessage[] = [];
    const runtime: InterviewSessionRuntime = {
      messages: async () => messages,
      notify: async () => {},
      continue: async () => {},
      rename: async () => {},
    };
    const service = createInterviewService({ directory } as never, undefined, {
      runtime,
      openBrowser: () => {},
    });
    service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');

    await service.handleCommandExecuteBefore(
      { command: 'interview', sessionID: 'ses_final', arguments: 'Final app' },
      { parts: [] },
    );
    const interviewID = service.getActiveInterviewId('ses_final');
    expect(interviewID).not.toBeNull();

    messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"Draft","questions":[{"id":"q-1","question":"Platform?","options":["Web"]}]}</interview_state>',
        },
      ],
    });
    await service.getInterviewState(interviewID as string);
    await service.submitAnswers(interviewID as string, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    await service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_final', status: { type: 'idle' } },
      },
    });
    await service.handleNudgeAction(interviewID as string, 'confirm-complete');

    messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '# Introduction\n\nA polished final specification.',
        },
      ],
    });
    const beforeCompletion = await service.getInterviewState(
      interviewID as string,
    );
    expect(beforeCompletion.document).not.toContain(
      'A polished final specification.',
    );
    await service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_final', status: { type: 'idle' } },
      },
    });
    const state = await service.getInterviewState(interviewID as string);
    const document = await fs.readFile(
      path.join(directory, 'interview', 'final-app.md'),
      'utf8',
    );

    expect(state.document).toContain('A polished final specification.');
    expect(document).toContain('sessionID: ses_final');
    expect(document).toContain('Q: Platform?');
    expect(document).toContain('A: Web');
    expect(document).not.toContain('<interview_state>');

    await fs.rm(directory, { recursive: true, force: true });
  });
});
