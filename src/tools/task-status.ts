import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import type { TaskActivityTracker } from './task-activity';

const z = tool.schema;

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
}): Record<'task_status', ToolDefinition> {
  const task_status = tool({
    description:
      'Read the current status of a tracked child task without resuming, prompting, or changing it. Accepts its task ID or parent-scoped alias.',
    args: {
      task_id: z.string().describe('Tracked task ID or parent-scoped alias'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_status requires task_id');

      const job = options.backgroundJobBoard.resolve(parentSessionID, requested);
      if (!job) throw new Error(`Unknown task ID or alias: ${requested}`);

      const statuses = await getClient(options.input).session.status({
        query: { directory: options.input.directory },
      });
      const live = isRecord(statuses.data) ? statuses.data[job.taskID] : undefined;
      const liveState = isRecord(live) && typeof live.type === 'string'
        ? live.type
        : undefined;
      const status = liveState ?? job.state;
      const now = options.now?.() ?? Date.now();
      const lastActivityAt = options.activityTracker?.lastActivityAt(job.taskID) ?? job.lastLiveBusyAt ?? job.runStartedAt;
      const idleSeconds = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
      const possiblyStuck = (status === 'busy' || status === 'retry') && idleSeconds >= 120;
      const details = [
        `Task ${job.alias} (${job.taskID})`,
        `state: ${status}`,
        `agent: ${job.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `idle_for_seconds: ${idleSeconds}`,
        `possibly_stuck: ${possiblyStuck}`,
      ];
      if (job.statusUncertain) details.push('status_uncertain: true');
      if (job.lastStatusError) details.push(`last_status_error: ${job.lastStatusError}`);
      return details.join('\n');
    },
  });

  return { task_status };
}
