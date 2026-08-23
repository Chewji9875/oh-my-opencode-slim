/**
 * Tool loop guard.
 *
 * Detects a session re-issuing the exact same tool call (same tool, same
 * arguments) consecutively with no change, which is how model-side infinite
 * loops present (see issue #1071: sub-agent repeating identical read/grep
 * calls forever).
 *
 * Behavior:
 * - N identical consecutive calls (LOOP_GUARD_WARN_AT): append corrective
 *   text to the tool output telling the model to stop and change approach.
 * - M identical consecutive calls (LOOP_GUARD_BLOCK_AT): refuse the call in
 *   tool.execute.before by throwing, so the loop terminates instead of
 *   running forever.
 *
 * Precedent: json-error-recovery (output warning) and task-session-manager
 * (before-hook refusal). The `task` tool is exempt: task-session-manager
 * already owns its duplicate-spawn guards (#1056/#1070).
 */

const LOOP_GUARD_WARN_AT = 3;
const LOOP_GUARD_BLOCK_AT = 5;

/** Exempt: task-session-manager already owns duplicate-spawn guards. */
const EXEMPT_TOOL = 'task';

const LOOP_GUARD_MARKER = '[REPEATED TOOL CALLS - STOP]';

export const LOOP_GUARD_WARNING = `
${LOOP_GUARD_MARKER}

You have issued the exact same tool call with identical arguments ${LOOP_GUARD_WARN_AT} times in a row and received identical results. This is an infinite loop and you are making no progress.

STOP repeating this call. Instead:
1. Reconsider what you are looking for; the result above already contains what this call can tell you.
2. If you need different information, make a DIFFERENT call (different path, pattern, or tool).
3. If the task is actually done, produce your final answer now instead of calling more tools.
`;

/** Deterministic fingerprint of tool + args, insensitive to key order. */
function fingerprint(tool: string, args: unknown): string {
  return `${tool.toLowerCase()}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`;
}

interface SessionState {
  /** Fingerprint of the most recent eligible call in this session. */
  last: string;
  /** How many consecutive identical calls have been observed. */
  count: number;
}

export interface ToolLoopGuardHook {
  'tool.execute.before': (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { args?: unknown },
  ) => Promise<void>;
  'tool.execute.after': (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { output: unknown; metadata?: unknown },
  ) => Promise<void>;
  resetSession(sessionID: string): void;
  resetForTests(): void;
}

export function createToolLoopGuardHook(): ToolLoopGuardHook {
  const sessions = new Map<string, SessionState>();
  /** Fingerprint per callID so `after` can re-check without re-deriving args. */
  const callKeys = new Map<string, string>();

  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID || input.tool.toLowerCase() === EXEMPT_TOOL) return;

      const key = fingerprint(input.tool, output.args);
      if (input.callID) callKeys.set(input.callID, key);

      const existing = sessions.get(sessionID);
      const count = existing && existing.last === key ? existing.count + 1 : 1;
      sessions.set(sessionID, { last: key, count });

      if (count >= LOOP_GUARD_BLOCK_AT) {
        throw new Error(
          `Refusing to execute "${input.tool}": this exact call (same tool, same arguments) has been issued ${count} times in a row with identical results and constitutes an infinite loop. Stop repeating it. Reassess your goal, make a different call, or produce your final answer.`,
        );
      }
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      if (!input.sessionID || input.tool.toLowerCase() === EXEMPT_TOOL) return;
      const state = sessions.get(input.sessionID);
      if (!state) return;

      const key = input.callID ? callKeys.get(input.callID) : undefined;
      if (input.callID) callKeys.delete(input.callID);
      if (
        key !== undefined &&
        (key !== state.last || state.count < LOOP_GUARD_WARN_AT)
      ) {
        return;
      }
      if (key === undefined && state.count < LOOP_GUARD_WARN_AT) return;

      if (typeof output.output !== 'string') return;
      if (output.output.includes(LOOP_GUARD_MARKER)) return;
      output.output += `\n${LOOP_GUARD_WARNING}`;
    },

    /** Clear all state for a finished/deleted session. */
    resetSession(sessionID: string): void {
      sessions.delete(sessionID);
    },

    /** Test seam: wipe state between cases. */
    resetForTests(): void {
      sessions.clear();
      callKeys.clear();
    },
  };
}
