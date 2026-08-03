import { describe, expect, test } from 'bun:test';
import { SessionMetadataStore } from './session-metadata';

describe('SessionMetadataStore', () => {
  test('bounds the union of directory and agent metadata', () => {
    const evicted: string[] = [];
    const store = new SessionMetadataStore({
      maxEntries: 2,
      onEvict: (sessionID) => evicted.push(sessionID),
    });

    store.setDirectory('directory-only', '/tmp/project');
    store.setAgent('agent-only', 'explore');
    store.setDirectory('newest', '/tmp/other-project');

    expect(store.size).toBe(2);
    expect(store.hasDirectory('directory-only')).toBe(false);
    expect(store.hasAgent('directory-only')).toBe(false);
    expect(store.hasAgent('agent-only')).toBe(true);
    expect(store.hasDirectory('newest')).toBe(true);
    expect(evicted).toEqual(['directory-only']);
  });

  test('retains the active orchestrator while evicting older metadata', () => {
    const store = new SessionMetadataStore({ maxEntries: 2 });

    store.setAgent('orchestrator-session', 'orchestrator');
    store.setDirectory('orchestrator-session', '/tmp/project');
    store.setAgent('older-specialist', 'explore');
    store.setDirectory('newer-specialist', '/tmp/project');

    expect(store.size).toBe(2);
    expect(store.getAgent('orchestrator-session')).toBe('orchestrator');
    expect(store.getDirectory('orchestrator-session')).toBe('/tmp/project');
    expect(store.hasAgent('older-specialist')).toBe(false);
    expect(store.hasDirectory('older-specialist')).toBe(false);
  });

  test('allows a deleted orchestrator to be evicted after cleanup', () => {
    const store = new SessionMetadataStore({ maxEntries: 2 });

    store.setAgent('orchestrator-session', 'orchestrator');
    store.setAgent('specialist-session', 'explore');
    store.delete('orchestrator-session');
    store.setDirectory('new-session', '/tmp/project');

    expect(store.size).toBe(2);
    expect(store.hasAgent('orchestrator-session')).toBe(false);
    expect(store.hasAgent('specialist-session')).toBe(true);
    expect(store.hasDirectory('new-session')).toBe(true);
  });

  test('protects the orchestrator reported busy by the session event', () => {
    const store = new SessionMetadataStore({ maxEntries: 2 });

    store.setAgent('first-orchestrator', 'orchestrator');
    store.setAgent('second-orchestrator', 'orchestrator');
    store.markOrchestratorBusy('first-orchestrator');
    store.setDirectory('new-session', '/tmp/project');

    expect(store.getAgent('first-orchestrator')).toBe('orchestrator');
    expect(store.hasAgent('second-orchestrator')).toBe(false);
    expect(store.hasDirectory('new-session')).toBe(true);
  });
});
