import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { extractSessionResult, SESSION_ID_PATTERN } from '../utils/session';

const z = tool.schema;

interface TaskResultToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  shouldManageSession: (sessionID: string) => boolean;
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
      if (toolContext.agent && toolContext.agent !== 'orchestrator') {
        throw new Error('task_result can only be used by orchestrator');
      }
      if (!options.shouldManageSession(parentSessionID)) {
        throw new Error(
          'task_result can only be used in orchestrator sessions',
        );
      }

      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_result requires task_id');

      const tracked = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (tracked?.state === 'running') {
        throw new Error(
          `Task ${requested} is still running. Wait for its terminal result instead of retrieving or duplicating it.`,
        );
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

      const statuses = await client.session.status({
        query: { directory: options.input.directory },
      });
      const statusMap = statuses.data;
      const status = isRecord(statusMap) ? statusMap[taskID] : undefined;
      if (
        isRecord(status) &&
        (status.type === 'busy' || status.type === 'retry')
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

      const result = await extractSessionResult(client, taskID, {
        directory: options.input.directory,
        includeReasoning: false,
      });
      if (result.empty) {
        throw new Error(`Task ${requested} has no completed text result`);
      }

      options.backgroundJobBoard.markUsed(parentSessionID, taskID);
      return result.text;
    },
  });

  return { task_result };
}
