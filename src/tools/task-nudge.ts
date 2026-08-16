import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getClient } from '../utils/opencode-client';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import {
  evaluateNudgeEligibility,
  observationFromSnapshot,
} from './task-policy';

const z = tool.schema;
const NUDGE_INTERVAL_MS = 30_000;

export function createTaskNudgeTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
}): Record<'task_nudge', ToolDefinition> {
  const lastNudgeAt = new Map<string, number>();
  const now = options.now ?? Date.now;
  const task_nudge = tool({
    description:
      'Safely send a bounded follow-up to a live child task without resuming, aborting, or starting another model run. Use only after task_status indicates the child may be stuck.',
    args: {
      task_id: z
        .string()
        .describe('Tracked live task ID or parent-scoped alias'),
      message: z
        .string()
        .min(1)
        .max(500)
        .describe('Short follow-up instruction'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_nudge requires sessionID');
      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        args.task_id.trim(),
      );
      if (!job) throw new Error(`Unknown task ID or alias: ${args.task_id}`);

      // Reserve the per-task rate-limit slot synchronously, before the first
      // await, so a concurrent nudge in the same window observes it. Any
      // failure rolls the reservation back so a refused or failed nudge
      // cannot lock the task out for the full interval.
      const at = now();
      const previous = lastNudgeAt.get(job.taskID);
      if (previous !== undefined && at - previous < NUDGE_INTERVAL_MS) {
        throw new Error(
          `Task ${args.task_id} was nudged recently; wait 30 seconds`,
        );
      }
      lastNudgeAt.set(job.taskID, at);

      try {
        // Admission requires the same live status/activity policy as
        // task_status: board-running, live-confirmed busy/retry, and
        // possibly stuck. A stale board record alone never admits a nudge.
        const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
          timeoutMs: options.statusTimeoutMs,
        });
        const currentJob = getCurrentNudgeJob(
          options.backgroundJobBoard,
          parentSessionID,
          args.task_id.trim(),
          job.taskID,
          job.generation,
        );
        const observation = observationFromSnapshot(snapshot, job.taskID);
        const lastActivityAt =
          options.activityTracker?.lastActivityAt(job.taskID) ??
          currentJob.lastLiveBusyAt ??
          currentJob.runStartedAt;
        const eligibility = evaluateNudgeEligibility(
          currentJob,
          observation,
          lastActivityAt,
          at,
        );
        if (!eligibility.eligible) {
          throw new Error(
            `Task ${args.task_id} cannot be nudged: ${eligibility.reason}`,
          );
        }

        const promptJob = getCurrentNudgeJob(
          options.backgroundJobBoard,
          parentSessionID,
          args.task_id.trim(),
          job.taskID,
          job.generation,
        );
        await getClient(options.input).session.prompt({
          path: { id: promptJob.taskID },
          body: {
            noReply: true,
            parts: [{ type: 'text', text: args.message.trim() }],
          },
        });
      } catch (error) {
        if (lastNudgeAt.get(job.taskID) === at) {
          lastNudgeAt.delete(job.taskID);
        }
        throw error;
      }
      return `Nudge admitted to ${job.alias} (${job.taskID}) without resuming it.`;
    },
  });
  return { task_nudge };
}

function getCurrentNudgeJob(
  backgroundJobBoard: BackgroundJobStore,
  parentSessionID: string,
  requested: string,
  expectedTaskID: string,
  expectedGeneration: number,
): NonNullable<ReturnType<BackgroundJobStore['get']>> {
  const current = backgroundJobBoard.get(expectedTaskID);
  const resolved = backgroundJobBoard.resolve(parentSessionID, requested);
  if (!current || !resolved || resolved.taskID !== expectedTaskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing to nudge stale execution`,
    );
  }
  if (
    current.taskID !== expectedTaskID ||
    current.generation !== expectedGeneration ||
    resolved.generation !== expectedGeneration
  ) {
    throw new Error(
      `Task ${requested} run generation changed; refusing to nudge stale execution`,
    );
  }
  if (current.state !== 'running') {
    throw new Error(
      `Task ${requested} cannot be nudged: board state is ${current.state}, not running`,
    );
  }
  if (current.cancellationRequested) {
    throw new Error(
      `Task ${requested} cannot be nudged: cancellation was requested`,
    );
  }
  return current;
}
