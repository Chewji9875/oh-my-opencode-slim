# src/hooks/task-session-manager/

## Responsibility

Manages background job-board state for `task` execution and injected
completion messages, enabling the orchestrator to track active jobs and reuse
only completed, reconciled child sessions by short aliases (e.g., `exp-1`,
`ora-2`). The implementation is split into focused submodules to improve
separation of concerns and maintainability.

## Design

The directory follows a **Facade + Strategy** pattern where `index.ts` acts as
the facade that composes and orchestrates behavior across specialized modules:

- **index.ts**: Main facade wiring hooks into OpenCode's lifecycle
  (`tool.execute.before`, `tool.execute.after`,
  `experimental.chat.messages.transform`, `event`) and exposing
  `beginUserWait()`, `hasInputWait()`, and `observeChatMessage()` to the
  `wait_for_user` tool, orchestrator-wake scheduler, and TUI. Also rehydrates
  historical running task parts into the board on transform.
- **board-injection.ts**: Cache-safe injection of Background Job Board state
  into the message stream via `cache-safe-injection.ts` helpers. Owns
  `injectBackgroundJobBoard`, injected-completion processing/fences, synthetic
  terminal part observation, running-task part stabilization (byte-stable
  running results), and retained board snapshots.
- **tool-execute-hooks.ts**: `tool.execute.before` (pending call creation,
  reusable/recoverable `task_id` resolution) and `tool.execute.after` (read
  context tracking, launch registration/update from task output).
- **event-router.ts**: Routes lifecycle events (`session.created`,
  `server.instance.disposed`, `session.idle`, `session.error`,
  `session.status`, `session.deleted`) to the appropriate subsystems; defers
  terminal bookkeeping for inline 401/410 errors while foreground-fallback
  can still recover.
- **idle-reconciliation.ts**: Delayed idle reconciliation (2s default) for
  parents and child jobs; child idle is a stop candidate with provisional
  observations; terminalizes deferred errors and reconciles injected terminal
  jobs on the backstop path.
- **runtime-status-reconciliation.ts**: Bounded (5s timeout) live
  session-status map reads (via `session-runtime-status.ts`) on a 5s delay,
  feeding the same stop-confirmation policy.
- **stop-confirmation.ts**: Shared 5s grace for idle/absent runtime
  observations. Transient non-busy evidence stays provisional; confirmed
  durable stop evidence calls `markStopped` and can wake the parent.
  Busy/retry/live-busy reset the clock.
- **idle-session-tokens.ts**: Per-instance session tokens that invalidate
  delayed idle-reconciliation timers when the parent becomes busy, errors,
  waits, or is deleted; real external user messages clear the process-global
  wait and rearm.
- **input-wait-tracker.ts**: Provides the single `hasInputWait()` seam used by
  idle reconciliation, orchestrator wake, and continuation evaluation. Combines
  local question/permission waits with the process-global explicit user-wait
  latch.
- **user-wait-gate.ts**: Process-global `wait_for_user` HITL latch shared via
  `globalThis` + `Symbol.for` across hook recreation; last-rearm identity
  (message ID or same-process object) prevents stale releases.
- **revived-run-tracker.ts**: Tracks revived task runs with notification
  retries, pending delivery, and a terminal-notification timeout so revived
  generations surface their completion reliably.
- **continuation-model-selection.ts**: Normalizes current-session and
  chat-hook model shapes before forwarding runtime model/variant choices to
  idle continuation and orchestrator-wake prompts.
- **status-utils.ts**: Output/status helpers (`extractTaskSummary`,
  `isActiveStatus`, `isLateCancelledTaskError`,
  `normalizeLateCancelledTaskOutput`).
- **pending-call-tracker.ts**: Tracks in-flight task calls using a capped
  ordered map (`MAX_PENDING_TASK_CALLS`) to correlate launch output safely.
- **task-context-tracker.ts**: Manages read context from child sessions with
  line-count and file caps; prunes to prevent unbounded growth.

All modules depend on `BackgroundJobBoard` (`src/utils/background-job-board.ts`)
as the single source of truth for active jobs, terminal unreconciled jobs,
reusable completed sessions, aliases, read context, and LRU caps, with
`background-job-store.ts` / `background-job-coordinator.ts` /
`background-job-supervisor.ts` providing the atomic store, lifecycle policy,
and wall-clock supervision.

### Key Abstractions

- **BackgroundJobBoard / BackgroundJobStore**: Central state store for task
  sessions (active, reusable, terminal unreconciled).
- **PendingTaskCall**: In-flight task invocation with call ID, parent session
  ID, agent type, label, and optional resumed task ID.
- **ContextFile**: Read context from child sessions with path, line numbers,
  and last-read timestamp.
- **User wait**: Explicit text-only HITL latch armed by `wait_for_user` and
  released by a distinct real external user message.
- **Stop confirmation**: 5s grace distinguishing provisional idle observations
  from confirmed durable stops.

## Flow

### Task Execution Lifecycle

1. **Before Execution (`tool.execute.before`)**
   - Intercepts `task` tool calls on managed sessions
   - Generates a task label from `description`/`prompt` via
     `deriveTaskSessionLabel`
   - Creates a `PendingTaskCall` record; resolves reusable task IDs from the
     job board (completed/reconciled jobs reusable by alias; timed-out running
     jobs recoverable only after a live busy signal)
   - Falls through to fresh task creation when nothing is reusable

2. **Task Launch (`tool.execute.after`)**
   - Registers launches in the job board with task ID, parent session ID,
     agent type, and description
   - Parses task output for task ID/status/launch info; adds read context
   - Handles late-cancelled tasks by normalizing output and updating state;
     clears rehydrate tombstones for genuinely new launches

3. **Context Tracking**
   - Extracts read files from `read` tool outputs; stores per task ID; prunes
     stale context during lifecycle events and status transitions

4. **Message Injection (`experimental.chat.messages.transform`)**
   - Stabilizes still-running task tool parts byte-for-byte (cache safety),
     rehydrates historical running tasks, then injects the `### Background Job
     Board` section as a tagged synthetic part via `cache-safe-injection.ts`
   - Remembers injected terminal jobs and reconciles them on the next request
     after the completion was surfaced to the model

5. **Lifecycle Events (`event`)**
   - `session.created`: adds new task IDs to pending managed set
   - `session.idle` / `session.status` (idle): schedules delayed
     reconciliation; child idle is a stop candidate subject to the 5s grace
   - `session.status` (busy): marks sessions running and resets pending stop
     confirmation
   - `session.error` (401/410): defers terminal bookkeeping while
     foreground-fallback may still recover
   - `session.deleted`: clears job state, child jobs, and pending calls
     (suppression tombstones kept)

6. **Human-in-the-loop Waits**
   - `wait_for_user` calls the facade's `beginUserWait()` after tool
     validation; the process-global latch cancels pending continuation and
     idle work until a distinct real user message arrives

### Data & Control Flow

```
User task call → tool.execute.before → PendingTaskCall created → task ID resolved/reused
→ tool.execute.after → BackgroundJobBoard.registerLaunch() → context extracted/added
→ supervisor.onLaunch() arms wall-clock deadline
→ Message transform → stabilize running parts → inject board as tagged synthetic part
→ session.idle → idle-reconciliation (delayed) / runtime-status reconciliation (5s)
→ stop-confirmation grace → markStopped or busy reset
→ revived-run-tracker delivers terminal notifications for revived generations
```

## Integration

### Consumers

- **Main Plugin (`src/index.ts`)**: wires the hook via
  `createTaskSessionManagerHook()`; forwards `hasInputWait`,
  `beginUserWait`, and `observeChatMessage` to the orchestrator-wake
  scheduler and TUI; shares `BackgroundJobSupervisor` for wall-clock
  deadlines.
- **Foreground-fallback**: `isFallbackInProgress` / `willAttemptFallback`
  guards keep the board from terminalizing sessions mid-fallback.
- **Orchestrator-wake**: reads `hasInputWait` and continuation-model state.

### Dependencies

- **BackgroundJobBoard / Store / Coordinator / Supervisor**
  (`src/utils/`): central state, atomic terminal transitions, lifecycle
  policy, wall-clock deadlines.
- **Session runtime status** (`src/utils/session-runtime-status.ts`): bounded
  live session-status map reads.
- **Task output parsing** (`src/utils/task.ts`): `parseTaskIdFromTaskOutput`,
  `parseTaskLaunchOutput`, `parseTaskStatusOutput`, `deriveTaskSessionLabel`.
- **Cache-safe injection** (`src/hooks/cache-safe-injection.ts`): the only
  allowed prompt-injection path.

### Configuration & Caps

- `maxSessionsPerAgent`: reusable sessions per agent type
- `maxRetainedSnapshots`: retained board snapshots for injection rollback
- `readContextMinLines` / `readContextMaxFiles`: read-context caps
- `strategy`: `'latest'` or `'checkpoint-compatible'`
- `orchestratorWake` (in `backgroundJobs`): periodic wake scheduling
- `wallClockTimeoutMs` / `abortGraceMs`: background job supervision

### Events & Hooks

- `tool.execute.before` / `tool.execute.after`: intercept task tool calls,
  register launches/status
- `experimental.chat.messages.transform`: inject job board state, stabilize
  running parts, rehydrate historical runs
- `event`: session lifecycle routing (created, idle, busy, error, deleted,
  server.instance.disposed)

## Module Decomposition Rationale

The original monolithic module was split to improve:
- **Separation of Concerns**: injection, reconciliation, wait gating, and
  revived-run tracking are distinct responsibilities.
- **Testability**: each module has focused contracts with isolated tests.
- **Maintainability**: changes to one concern do not affect unrelated logic.
- **Cache safety**: all prompt injection routes through the cache-safe helpers
  and is guarded by the cache-safety property/snapshot tests.

Each submodule adheres to the **Single Responsibility Principle** while
collaborating through the facade to provide a cohesive user experience.
