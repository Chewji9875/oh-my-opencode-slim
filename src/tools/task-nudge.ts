import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getClient } from '../utils/opencode-client';

const z = tool.schema;
const NUDGE_INTERVAL_MS = 30_000;

export function createTaskNudgeTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  now?: () => number;
}): Record<'task_nudge', ToolDefinition> {
  const lastNudgeAt = new Map<string, number>();
  const now = options.now ?? Date.now;
  const task_nudge = tool({
    description:
      'Safely send a bounded follow-up to a live child task without resuming, aborting, or starting another model run. Use only after task_status indicates the child may be stuck.',
    args: {
      task_id: z.string().describe('Tracked live task ID or parent-scoped alias'),
      message: z.string().min(1).max(500).describe('Short follow-up instruction'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_nudge requires sessionID');
      const job = options.backgroundJobBoard.resolve(parentSessionID, args.task_id.trim());
      if (!job) throw new Error(`Unknown task ID or alias: ${args.task_id}`);
      if (job.state !== 'running') {
        throw new Error(`Task ${args.task_id} is not running and cannot be nudged`);
      }
      const at = now();
      const previous = lastNudgeAt.get(job.taskID);
      if (previous !== undefined && at - previous < NUDGE_INTERVAL_MS) {
        throw new Error(`Task ${args.task_id} was nudged recently; wait 30 seconds`);
      }
      await getClient(options.input).session.prompt({
        path: { id: job.taskID },
        body: { noReply: true, parts: [{ type: 'text', text: args.message.trim() }] },
      });
      lastNudgeAt.set(job.taskID, at);
      return `Nudge admitted to ${job.alias} (${job.taskID}) without resuming it.`;
    },
  });
  return { task_nudge };
}
