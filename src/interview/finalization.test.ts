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
      path.join(directory, state.markdownPath),
      'utf8',
    );

    expect(state.document).toContain('A polished final specification.');
    expect(document).toContain('sessionID: ses_final');
    expect(document).toContain('Q: Platform?');
    expect(document).toContain('A: Web');
    expect(document).not.toContain('<interview_state>');

    await fs.rm(directory, { recursive: true, force: true });
  });

  test('isolates concurrent interviews with the same slug through finalization', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-collision-');
    const scenarios = await Promise.all(
      ['alpha', 'beta'].map(async (label) => {
        const messages: InterviewMessage[] = [];
        const runtime: InterviewSessionRuntime = {
          messages: async () => messages,
          notify: async () => {},
          continue: async () => {},
          rename: async () => {},
        };
        const service = createInterviewService(
          { directory } as never,
          undefined,
          {
            runtime,
            openBrowser: () => {},
          },
        );
        service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');

        await service.handleCommandExecuteBefore(
          {
            command: 'interview',
            sessionID: `ses_${label}`,
            arguments: 'Same Slug Product',
          },
          { parts: [] },
        );

        return { label, messages, service, sessionID: `ses_${label}` };
      }),
    );

    const records = scenarios.map((scenario) => {
      const interviewID = scenario.service.getActiveInterviewId(
        scenario.sessionID,
      );
      expect(interviewID).not.toBeNull();
      return { ...scenario, interviewID: interviewID as string };
    });

    await Promise.all(
      records.map(async ({ label, messages, service, interviewID }) => {
        messages.push({
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: `<interview_state>{"summary":"${label} draft","title":"Shared Product","questions":[{"id":"q-1","question":"${label} question?","options":["Yes"]}]}</interview_state>`,
            },
          ],
        });
        await service.getInterviewState(interviewID);
        await service.submitAnswers(interviewID, [
          { questionId: 'q-1', answer: `${label} answer` },
        ]);
        await service.handleEvent({
          event: {
            type: 'session.status',
            properties: {
              sessionID: `ses_${label}`,
              status: { type: 'idle' },
            },
          },
        });
        await service.handleNudgeAction(interviewID, 'confirm-complete');
        messages.push({
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: `# ${label} final\n\n${label} final specification.`,
            },
          ],
        });
        await service.handleEvent({
          event: {
            type: 'session.status',
            properties: {
              sessionID: `ses_${label}`,
              status: { type: 'idle' },
            },
          },
        });
      }),
    );

    const states = await Promise.all(
      records.map(({ service, interviewID }) =>
        service.getInterviewState(interviewID),
      ),
    );
    const paths = states.map((state) =>
      path.join(directory, state.markdownPath),
    );

    expect(paths[0]).not.toBe(paths[1]);
    expect(path.basename(paths[0])).toMatch(/^shared-product-[0-9a-f-]+\.md$/);
    expect(path.basename(paths[1])).toMatch(/^shared-product-[0-9a-f-]+\.md$/);

    const documents = await Promise.all(
      paths.map((documentPath) => fs.readFile(documentPath, 'utf8')),
    );
    expect(documents[0]).toContain('alpha final specification.');
    expect(documents[0]).toContain('A: alpha answer');
    expect(documents[0]).not.toContain('beta final specification.');
    expect(documents[0]).not.toContain('A: beta answer');
    expect(documents[1]).toContain('beta final specification.');
    expect(documents[1]).toContain('A: beta answer');
    expect(documents[1]).not.toContain('alpha final specification.');
    expect(documents[1]).not.toContain('A: alpha answer');

    await fs.rm(directory, { recursive: true, force: true });
  });

  test('serializes overlapping writes from sessions resuming one document', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-resume-lock-');
    const documentPath = path.join(directory, 'interview', 'shared.md');
    await fs.mkdir(path.dirname(documentPath), { recursive: true });
    await fs.writeFile(
      documentPath,
      '# Shared document\n\n## Current spec\n\nDraft.\n\n## Q&A history\n\nNo answers yet.\n',
      'utf8',
    );

    const messages = new Map<string, InterviewMessage[]>();
    const runtime: InterviewSessionRuntime = {
      messages: async (sessionID) => messages.get(sessionID) ?? [],
      notify: async () => {},
      continue: async () => {},
      rename: async () => {},
    };
    const service = createInterviewService({ directory } as never, undefined, {
      runtime,
      openBrowser: () => {},
    });
    service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');

    for (const sessionID of ['ses_one', 'ses_two']) {
      await service.handleCommandExecuteBefore(
        { command: 'interview', sessionID, arguments: documentPath },
        { parts: [] },
      );
    }

    messages.set('ses_one', [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>{"summary":"One draft","questions":[{"id":"q-one","question":"One?","options":["Yes"]}]}</interview_state>',
          },
        ],
      },
    ]);
    messages.set('ses_two', [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>{"summary":"Two draft","questions":[{"id":"q-two","question":"Two?","options":["Yes"]}]}</interview_state>',
          },
        ],
      },
    ]);

    const interviewIDs = ['ses_one', 'ses_two'].map((sessionID) => {
      const interviewID = service.getActiveInterviewId(sessionID);
      expect(interviewID).not.toBeNull();
      return interviewID as string;
    });
    await Promise.all(
      interviewIDs.map((interviewID) => service.getInterviewState(interviewID)),
    );
    await Promise.all([
      service.submitAnswers(interviewIDs[0] as string, [
        { questionId: 'q-one', answer: 'One answer' },
      ]),
      service.submitAnswers(interviewIDs[1] as string, [
        { questionId: 'q-two', answer: 'Two answer' },
      ]),
    ]);

    const document = await fs.readFile(documentPath, 'utf8');
    expect(document).toContain('A: One answer');
    expect(document).toContain('A: Two answer');

    await fs.rm(directory, { recursive: true, force: true });
  });
});
