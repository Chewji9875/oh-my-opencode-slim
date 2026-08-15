import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobRecord } from '../utils/background-job-board';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getClient } from '../utils/opencode-client';
import {
  extractFinalSessionResult,
  SESSION_ID_PATTERN,
} from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';

const z = tool.schema;

interface TaskResultToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
}

/**
 * Gate tracked task retrieval on the tracked terminal outcome. Only a
 * `completed` state (or a reconciled job whose terminal outcome was
 * `completed`) may yield a successful result; running, errored and cancelled
 * jobs are rejected explicitly and accurately instead of leaking partial
 * output as a final result.
 */
function assertRetrievableState(
  requested: string,
  job: BackgroundJobRecord,
): void {
  const terminalState =
    job.state === 'reconciled' ? job.terminalState : job.state;

  if (terminalState === 'running') {
    throw new Error(
      `Task ${requested} is still running. Wait for its terminal result instead of retrieving or duplicating it.`,
    );
  }
  if (terminalState === 'error') {
    throw new Error(
      `Task ${requested} ended in error: ${job.lastStatusError ?? job.resultSummary ?? 'no error details available'}`,
    );
  }
  if (terminalState === 'cancelled') {
    const reason = job.resultSummary?.replace(/^cancelled:\s*/i, '');
    throw new Error(
      `Task ${requested} was cancelled${reason ? `: ${reason}` : ''}`,
    );
  }
  if (terminalState !== 'completed') {
    throw new Error(`Task ${requested} has no confirmed completed result`);
  }
}

export function createTaskResultTool(
  options: TaskResultToolOptions,
): Record<string, ToolDefinition> {
  const task_result = tool({
    description: `Retrieve the final text already produced by a specialist task without resuming or re-running it.

Use this when the user asks to see a prior task's full result, or before retrying work whose completed output may already answer the request. Accepts either the native task_id/session ID or the parent-scoped alias shown in the Background Job Board. This tool is read-only and never sends a new prompt to the specialist.`,
    args: {
      task_id: z
        .string()
        .describe('Completed task ID or Background Job Board alias'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_result requires sessionID');
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_result requires task_id');

      let tracked = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );

      // A stopped board record is only a provisional observation. Re-check the
      // live runner once, with the same bounded status path used elsewhere,
      // before rejecting it. A busy/retry observation self-heals that record
      // and prevents a stale stopped gate from hiding a still-live task.
      let liveSnapshot: RuntimeSessionStatusSnapshot | undefined;
      if (tracked?.state === 'stopped') {
        liveSnapshot = await getRuntimeSessionStatusSnapshot(options.input);
        const liveStatus = runtimeSessionStatus(liveSnapshot, tracked.taskID);
        if (liveStatus === 'busy' || liveStatus === 'retry') {
          options.backgroundJobBoard.markRunningFromLiveSession(
            tracked.taskID,
            Date.now(),
            tracked.generation,
          );
          tracked = options.backgroundJobBoard.resolve(
            parentSessionID,
            requested,
          );
        }
      }

      if (tracked) {
        assertRetrievableState(requested, tracked);
      }

      const taskID = tracked?.taskID ?? requested;
      if (!SESSION_ID_PATTERN.test(taskID)) {
        throw new Error(`Unknown task ID or alias: ${requested}`);
      }

      const client = getClient(options.input);
      const sessionClient = client.session as typeof client.session & {
        get?: typeof client.session.get;
      };
      if (sessionClient.get) {
        const session = await sessionClient.get({
          path: { id: taskID },
          query: { directory: options.input.directory },
        });
        const info = session.data as { parentID?: string } | undefined;
        if (info?.parentID !== parentSessionID) {
          throw new Error(`Task ${requested} does not belong to this session`);
        }
      } else if (!tracked) {
        throw new Error(
          `Task ${requested} is not tracked by this session and cannot be verified`,
        );
      }

      liveSnapshot ??= await getRuntimeSessionStatusSnapshot(options.input);
      const status = runtimeSessionStatus(liveSnapshot, taskID);
      const trackedTerminalState = tracked
        ? tracked.state === 'reconciled'
          ? tracked.terminalState
          : tracked.state
        : undefined;
      if (
        (status === 'busy' || status === 'retry') &&
        trackedTerminalState !== 'completed'
      ) {
        throw new Error(
          `Task ${requested} is still running. Wait for its terminal result instead of retrieving or duplicating it.`,
        );
      }

      if (!sessionClient.get) {
        const result = tracked?.resultSummary?.trim();
        if (!result) {
          throw new Error(`Task ${requested} has no completed text result`);
        }
        options.backgroundJobBoard.markUsed(parentSessionID, taskID);
        return result;
      }

      const result = await extractFinalSessionResult(client, taskID, {
        directory: options.input.directory,
        includeReasoning: false,
      });
      if (result.empty) {
        throw new Error(`Task ${requested} has no completed text result`);
      }
      if (!tracked && result.terminal !== true) {
        throw new Error(
          `Task ${requested} shows no terminal evidence of completion; refusing to present partial output as its final result`,
        );
      }

      options.backgroundJobBoard.markUsed(parentSessionID, taskID);
      return result.text;
    },
  });

  return { task_result };
}
