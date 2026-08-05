# Loop Engineering: Research, Building Blocks & Tool Comparison

> Research compiled from 112 sources across 9 platforms (Reddit, X, YouTube, TikTok, Instagram, Hacker News, GitHub, Digg, Web) on 2026-06-27.

---

## What Is Loop Engineering?

Loop engineering is the practice of replacing yourself as the person who prompts a coding agent. Instead of typing instructions turn-by-turn, you design a system that finds work, hands it to agents, checks results, records progress, and decides the next action - on a schedule or until a goal is met.

The term crystallized in June 2026 around two viral moments:

- **Peter Steinberger** (creator of OpenClaw): "You shouldn't be prompting coding agents anymore. You should be designing loops that prompt your agents." (June 7, 2026 - 6.5M views)
- **Boris Cherny** (head of Claude Code at Anthropic): "I don't prompt Claude anymore. I have loops running. They're the ones prompting Claude and figuring out what to do. My job is to write loops." (June 5, 2026)

Google engineer **Addy Osmani** then published the essay that gave the practice its name and anatomy: five building blocks plus memory.

---

## The Five Building Blocks

Osmani's framework identifies five primitives that compose a loop, plus durable state:

### 1. Automations (Trigger + Schedule)

**What it does:** Discovers work on a timer or event, triages it, and feeds it to the agent loop.

**Why it matters:** Without automation, you're still manually kicking off each run. Automation is what makes the loop autonomous.

**Examples:** Cron jobs, GitHub Actions, event-driven triggers, scheduled scans.

### 2. Worktrees (Isolation)

**What it does:** Gives each parallel agent its own isolated git checkout so multiple agents don't collide on the same files.

**Why it matters:** Parallel sub-agents editing the same branch create merge conflicts and corrupted state. Worktrees prevent this.

**Examples:** `git worktree`, per-thread isolation, per-agent directories.

### 3. Skills (Project Knowledge)

**What it does:** Codifies project conventions, build steps, and domain knowledge into files the agent reads every run. Prevents "intent debt" - the agent guessing wrong about how your project works.

**Why it matters:** An agent starts every session cold. Without written knowledge, it fills gaps with confident guesses. Skills are intent written down once, read every time.

**Examples:** `SKILL.md` files, `CLAUDE.md`, `AGENTS.md`, project-specific instructions.

### 4. Connectors (Tool Integration)

**What it does:** Wires the agent into real tools - databases, APIs, file systems, CI/CD, issue trackers.

**Why it matters:** A loop that can't act on the real world is just a thought experiment. Connectors give it hands.

**Examples:** MCP servers, CLI tools, API integrations, database connections.

### 5. Sub-agents (Maker/Checker Split)

**What it does:** Separates the agent that does the work (maker) from the agent that verifies it (checker). One agent proposes, a different one validates.

**Why it matters:** A single agent grading its own work is like a student marking their own exam. The maker/checker split is what makes unattended loops trustworthy.

**Examples:** Dedicated reviewer agents, test runners, lint checkers, oracle reviewers.

### Plus: Durable State (Memory)

**What it does:** Persists what was tried, what passed, and what's still open between loop iterations. Lives on disk, not in the context window.

**Why it matters:** The model forgets between sessions. The repo doesn't. State files, git history, and progress logs are the loop's long-term memory.

---

## Tool Comparison: Claude Code vs Codex vs OpenCode

### Automations / Scheduling

| Feature | Claude Code | Codex | OpenCode |
|---------|-------------|-------|----------|
| `/goal` command | Yes | Yes | No |
| `/loop` command | Yes | No | Yes (registered, prompt-driven) |
| `/batch` command | Yes | No | No |
| Scheduled automations | Yes (hooks, GitHub Actions) | Yes (Automations tab) | No (Phase 4) |
| Event triggers | Yes (hooks) | Yes (triage inbox) | No |
| Cron-like scheduling | Yes | Yes | No |

**Verdict:** Claude Code and Codex both ship full automation primitives. OpenCode
has a registered, prompt-driven `/loop` entry point, but no scheduling
automation or fully integrated runtime `LoopEngine`; `LoopSession` primitives
exist separately.

### Worktrees (Isolation)

| Feature | Claude Code | Codex | OpenCode |
|---------|-------------|-------|----------|
| Git worktree support | Yes (`--worktree`) | Yes (built-in per thread) | Yes (orchestrator skill) |
| Sub-agent isolation | Yes (`isolation: worktree`) | Yes (built-in) | Yes (apply-patch hook) |
| Programmatic creation | Yes | Yes | No (skill-only, prompt-driven) |
| Loop integration | Yes | Yes | No (runtime integration absent) |

**Verdict:** Claude Code and Codex have worktrees as runtime primitives integrated with their loop engines. OpenCode has worktrees as an orchestrator skill with apply-patch support, but no programmatic runtime integration yet.

### Skills (Project Knowledge)

| Feature | Claude Code | Codex | OpenCode |
|---------|-------------|-------|----------|
| `SKILL.md` format | Yes | Yes | Yes |
| Per-agent assignment | Yes | Yes | Yes (with permissions) |
| Bundled skills | No (user-created) | Yes (Agent Skills) | Yes (8 bundled) |
| Skill marketplace | Yes (plugins) | Yes | No |
| Intent debt prevention | Yes | Yes | Yes |

**Verdict:** All three have mature skill systems. OpenCode's is notably rich
with 8 bundled skills, per-agent permission control, and automatic sync on
plugin updates.

### Connectors / MCP

| Feature | Claude Code | Codex | OpenCode |
|---------|-------------|-------|----------|
| MCP server support | Yes | Yes (Connectors) | Yes |
| Built-in MCPs | No (user-configured) | Yes | Yes (3 built-in) |
| Per-agent MCP permissions | No | No | Yes (wildcard, exclusion, explicit) |
| Remote MCP servers | Yes | Yes | Yes |
| Local MCP servers | Yes | Yes | Yes |

**Verdict:** All three support MCP. OpenCode stands out with 3 built-in MCPs (websearch, context7, gh_grep) and a sophisticated per-agent permission system.

### Sub-agents (Maker/Checker Split)

| Feature | Claude Code | Codex | OpenCode |
|---------|-------------|-------|----------|
| Agent spawning | Yes | Yes | Yes (9 agents) |
| Background execution | Yes | Yes | Yes (background jobs) |
| Maker/checker split | Yes | Yes | Yes (orchestrator dispatches, specialists execute) |
| Depth tracking | Yes | Yes | Native (OpenCode's subagent_depth) |
| Session reuse | Yes | Yes | Yes (BackgroundJobBoard) |
| Job tracking | Limited | Limited | Yes (Background Job Board with aliases) |
| Cancellation | Yes | Yes | Yes (cancel_task tool) |
| Parallel dispatch | Yes | Yes | Yes (explicit in orchestrator prompt) |

**Verdict:** All three have sub-agent support. OpenCode's is the most structured with 9 specialized agents, a formal Background Job Board, session reuse, and a dedicated orchestrator that never implements directly.

### Loop Engine (Iteration Primitive)

| Feature | Claude Code | Codex | OpenCode |
|---------|-------------|-------|----------|
| Built-in loop command | Yes (`/goal`, `/loop`) | Yes (`/goal`) | Yes (`/loop`, registered and prompt-driven) |
| Success criteria | Yes (test, build, lint) | Yes | Partial (criteria types exist in `LoopSession`; no integrated runtime) |
| Iteration cap | Yes | Yes | Partial (`LoopSession` stores `maxAttempts`; no integrated runtime) |
| No-progress detection | Yes | Yes | No integrated runtime (planned signals only) |
| Escalation to human | Yes | Yes | Partial (`LoopSession` has escalation/manual-review state) |
| Cost budgeting | Limited | Limited | No integrated runtime (planned) |

**Verdict:** Claude Code and Codex have working loop primitives. OpenCode's
`/loop` entry point is registered and prompt-driven, and `LoopSession`
primitives cover definitions, phases, attempts, and history. A fully
integrated runtime `LoopEngine` is not implemented.

---

## The Ralph Technique

### What Is Ralph?

The Ralph Wiggum loop is a specific implementation pattern for loop engineering. Named by Geoffrey Huntley in July 2025 after The Simpsons character Ralph Wiggum ("I'm in danger!"), it's the simplest possible loop:

```bash
while :; do cat PROMPT.md | claude; done
```

In its purest form, Ralph is a Bash loop. That's it.

### How It Works

1. **Define a PRD** (Product Requirements Document) with small, atomic tasks
2. **Write a PROMPT.md** that instructs the agent to read the PRD and work on one task
3. **Run the loop** - each iteration spawns a fresh agent instance with clean context
4. **Memory persists via disk** - git history, `progress.txt`, and `prd.json` survive between iterations
5. **Stop when done** - the agent signals completion, or a max iteration cap is hit

### The Four Principles

1. **Each iteration = fresh context.** The agent doesn't remember the previous iteration. Only git history, progress.txt, and prd.json persist.
2. **Keep tasks small.** Each PRD item must fit in a single context window. "Build the entire dashboard" is too large. "Add a filter dropdown to a list" is right.
3. **Update AGENTS.md.** Write discovered patterns and precautions at the end of each iteration. The next iteration reads them.
4. **Failures are data.** Deterministically bad means failures are predictable and informative. The loop learns from them.

### Ralph vs Full Loop Engineering

| Aspect | Ralph Technique | Full Loop Engineering |
|--------|----------------|----------------------|
| **Complexity** | Single Bash loop | Multi-block system (automations, worktrees, skills, connectors, sub-agents) |
| **Context management** | Fresh context each iteration (via disk memory) | Persistent context with durable state |
| **Verification** | Manual (human reviews diffs) | Automated maker/checker split |
| **Parallelism** | Sequential (one agent at a time) | Parallel sub-agents with worktree isolation |
| **Scheduling** | Manual trigger | Automated (cron, events, webhooks) |
| **Tool integration** | Minimal (git + agent) | Full MCP connectors |
| **Cost control** | Manual (max iterations) | Automatic (token budgets, no-progress detection) |
| **Best for** | Well-defined, test-driven tasks | Complex, multi-step, long-running work |

### When to Use Ralph

- Tasks are well-defined and test-driven
- You want maximum simplicity
- You're comfortable reviewing diffs manually
- The codebase is small enough for fresh context each iteration
- You want to start loop engineering today with zero setup

### When to Use Full Loop Engineering

- Tasks require parallel work across multiple files
- You need automated verification (maker/checker)
- The work spans multiple days or sessions
- You need cost controls and budget management
- The codebase is large and context-heavy

---

## OpenCode's Loop Engineering Status

### What Exists Today

| Building Block | Status | Implementation |
|----------------|--------|----------------|
| **Skills** | Mature | 8 bundled skills, per-agent permissions, auto-sync |
| **Connectors/MCP** | Mature | 3 built-in MCPs, per-agent permission system |
| **Sub-agents** | Mature | 9 agents, Background Job Board, session reuse |
| **Worktrees** | Skill-only | Orchestrator skill, apply-patch hook support |
| **Automations** | Not implemented | Deferred to Phase 4 |
| **Loop engine** | Partial | Registered, prompt-driven `/loop` entry point and `LoopSession` primitives; no fully integrated runtime `LoopEngine` |

### Existing Loop Primitives

OpenCode currently has a registered, prompt-driven `/loop` entry point. The
`LoopSession` module provides definitions, phases, attempts, success-criterion
types, manual-review state, and per-attempt history persistence. These are
building blocks, not a complete runtime loop.

### What's Designed But Not Built

The planned loop engineering runtime includes:

- **LoopEngine** class with event-driven orchestration
- **Integrated runtime wiring** from `/loop` parsing through `LoopSession`,
  background execution, verification, iteration, and escalation
- **SuccessCriterion** routing (test, build, lint, fileExists, command, oracle, observer)
- **Convergence signals** (totalErrors, timeoutCount, lastErrorAt)
- **Integrated history compaction** across loop attempts and sessions
- **Escalation via @council** at Layer 0 only
- **Phased rollout:** Phase 1 (runtime engine) -> Phase 2 (loop skill) -> Phase 3 (routine integration) -> Phase 4 (triggers) -> Phase 5 (persistent memory)

### The Gap

OpenCode has 3 of 5 building blocks fully wired (skills, connectors, sub-agents),
worktrees as a skill, and automations still unimplemented. Loop support is
partial: `/loop` is registered and prompt-driven, and `LoopSession` primitives
exist, but a fully integrated runtime `LoopEngine` does not. The sub-agent
infrastructure is the strongest piece - the Background Job Board, session reuse,
and native depth tracking are more structured than what Claude Code or Codex
expose.

The missing piece is the integrated outer loop runtime: the scheduler and
iteration engine that connect the prompt-driven entry point to execution,
verification, and continued progress without human intervention. Once that
lands, OpenCode will have a complete loop engineering stack.

---

## Case Study: Andrej Karpathy's autoresearch

[autoresearch](https://github.com/karpathy/autoresearch) (March 2026) is the purest real-world implementation of loop engineering. It's a minimalist autonomous AI research framework: one Python file to edit (`train.py`), one fixed evaluation harness (`prepare.py`), and one Markdown "skill" file (`program.md`) that drives an AI agent to run an infinite experiment loop.

### How It Works

1. The agent reads `program.md` which defines a `LOOP FOREVER` construct
2. It modifies `train.py` with an experimental idea
3. Runs a 5-minute training experiment on a single GPU
4. Evaluates validation bits-per-byte (BPB)
5. If improved: keeps the commit, advances the branch
6. If same or worse: git resets to previous state
7. Repeats indefinitely (~12 experiments/hour, ~100 per night)

### Mapping to the 5 Building Blocks

| Building Block | autoresearch | Notes |
|---|---|---|
| **Automations** | The agent IS the scheduler | `LOOP FOREVER` in program.md, no external cron |
| **Worktrees** | Not used | Single-agent, single-file system |
| **Skills** | `program.md` IS the skill | Explicitly called "a super lightweight skill" |
| **Connectors** | Not used | Agent's native tools only (git, python) |
| **Sub-agents** | Not used | Single-agent system |

### Comparison to Ralph and Full Loop Engineering

| Aspect | autoresearch | Ralph | Full Loop Engineering |
|---|---|---|---|
| Agent lifetime | Continuous (one session) | Fresh per iteration | Continuous with sub-agents |
| Context | Grows within session | Reset each iteration | Persistent + fresh sub-agent contexts |
| Memory | Git + results.tsv | Git + progress.txt + prd.json | Durable state files + skills |
| Verification | Automated (val_bpb check) | Manual (human reviews diffs) | Maker/checker split |
| Scheduling | Agent self-schedules | Manual trigger | Cron/events |
| Parallelism | None | None | Parallel sub-agents |
| Complexity | ~100 lines (program.md) | ~50 lines (Bash loop) | Hundreds of lines across 5 blocks |

### Key Lessons

1. **The skill file is the most important piece.** `program.md` defines the loop, success criteria, and failure handling. Without it, the agent has no idea what to do.

2. **Git is sufficient memory for many loops.** No need for complex state management. The commit history IS the state.

3. **A fixed time budget makes experiments comparable.** Every experiment runs for exactly 5 minutes, regardless of what the agent changes. This is critical for fair evaluation.

4. **Fast-fail prevents wasted compute.** NaN or exploding loss (>100) causes immediate exit. No point running 5 minutes of garbage.

5. **The agent can be its own scheduler.** For simple loops, no external cron is needed. The agent follows the loop instructions and keeps going.

6. **Minimum viable loop = skill + git + evaluation.** You don't need the full 5-block stack to get value from loop engineering. Start simple, add complexity when the task demands it.

---

## Key Takeaways

1. **The shift is real.** The people building the most-used coding agents have stopped prompting by hand. The leverage moved from the model to the loop around it.

2. **The five blocks are converging.** Claude Code and Codex ship nearly identical primitives. The pattern is becoming tool-agnostic.

3. **Ralph is the simplest on-ramp.** If you want to start loop engineering today, a Bash loop + PRD + git history is enough. Scale up to full loop engineering when the complexity demands it.

4. **The skill is the asset.** A loop with no reusable skills inside it is just a while-true around a stranger. Build skills worth calling.

5. **Cost is the immediate bottleneck.** Token consumption scales linearly with loop iterations. Budget caps are mandatory, not optional.

6. **OpenCode has a strong partial foundation.** Skills, connectors, and
   sub-agents are mature. `/loop` is registered and prompt-driven, and
   `LoopSession` primitives exist, but automations and a fully integrated runtime
   `LoopEngine` remain incomplete. The sub-agent infrastructure is the strongest
   piece of the stack.

7. **autoresearch proves the minimum viable loop.** You don't need the full 5-block stack. A skill file + git + evaluation metric is enough to run autonomous experiments overnight. Start simple, add complexity when the task demands it.

---

*Sources: Addy Osmani (addyosmani.com), Peter Steinberger (@steipete), Boris Cherny (Anthropic), Matt Van Horn (techtwitter.com), Geoffrey Huntley (ghuntley.com/ralph), snarktank/ralph (GitHub), Andrej Karpathy (autoresearch), awesomeclaude.ai, lushbinary.com, StationX, The Register, The New Stack, Business Insider, and 100+ Reddit/X/YouTube/TikTok threads.*
