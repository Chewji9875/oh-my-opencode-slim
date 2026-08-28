# OpenCode v2 (`opencode2`) Compatibility

oh-my-opencode-slim installs and runs on **both** OpenCode v1 (`opencode`) and
OpenCode v2 (`opencode2`) from a single published package. This document
explains how the dual-compatibility works, what is supported on each host, the
minimum v2 build each feature needs, and how it degrades on older builds.

## How it works

The package's default export is an object:

```ts
export default {
  id: 'oh-my-opencode-slim',
  tui: true,             // marker: this package ships a `./tui` entry for v2 TUI hosts
  server: OhMyOpenCodeLite, // v1 plugin function (PluginInput) => Promise<Hooks>
  setup: createV2Setup(),   // v2 promise-plugin setup (ctx) => Promise<cleanup>
};
```

- **v1 loader** (`readV1Plugin` in `packages/opencode/src/plugin/shared.ts`)
  detects an object with a `server` field and calls `plugin.server(input)`.
  This is the original, unchanged v1 code path — v1 behavior is identical to
  previous releases.
- **v2 loader** (`PluginModule` schema in
  `packages/core/src/plugin/supervisor.ts`) decodes `default` as
  `{ id, setup }` (Effect Schema 4 rejects function defaults) and calls
  `setup(ctx)` via the promise-plugin bridge.
- **v2 TUI** additionally loads the `./tui` entry (below) when the server-side
  export declares `tui: true`.

Three builds are produced:

| Export | File | Build | Externals |
|---|---|---|---|
| `.` (main) | `dist/index.js` | `build:plugin` | zod, jsdom, @opencode-ai/*, @opentui/* (shared with v1 host) |
| `./server` | `dist/server.js` | `build:v2` | jsdom only (self-contained for v2) |
| `./tui` | `dist/tui2.js` | `build:tui` | same external set as `build:plugin` (composes the v1 TUI entry; inlines zod) |

v2's plugin resolver tries the `server` subpath first
(`subpaths: ["server", ""]`), so a v2 package install loads the self-contained
`dist/server.js`. v1 uses the main entry.

**Supported v2 builds:** verified on `beta-18269` and `beta-18286` (add-only
command drafts; flat session `prompt`/`synthetic`/`rename`/`switchAgent`).
Newer builds add the capabilities listed under
[Capability floors](#capability-floors-and-version-policy).

## The v2 adapter (`src/v2/setup.ts`)

`setup(ctx)` wraps the existing v1 factory rather than reimplementing it:

1. Builds a v1-shaped `PluginInput` from the v2 context
   (`src/v2/client-shim.ts`): the project directory from `ctx.location`
   (v2 ≥ #45403; `process.cwd()` on older builds), and a shim `client` that
   **really delegates** the v1 SDK call shapes to v2 flat session calls —
   `session.get`, `session.abort`→`interrupt`, `session.messages`→`context`,
   `session.prompt` (as `delivery: "steer"`), and `session.update`→`rename`.
   The shim marks the input `hostFlavor: 'v2'` and never fakes success
   shapes: methods the host lacks degrade with an honest log (or are omitted
   entirely, as with `session.get`, so capability probes see the truth).
2. Invokes `OhMyOpenCodeLite(pluginInput)` to reuse **all** existing build
   logic (config, agents, tools, hooks, job board, multiplexer, companion).
3. Runs the v1 `config()` hook against a synthesized config to resolve agent
   models and the slash commands.
4. Bridges the returned v1 `Hooks` into v2 registrations:
   - `agent` → `ctx.agent.transform` (model/prompt/permission adaptation +
     `subagent`/`execute` permission mapping + prompt rewrite `task`→`subagent`
     + `draft.default("orchestrator")`)
   - `tool` → `ctx.tool.transform` (zod shape → JSON schema; execute shimmed)
   - `mcp` → `ctx.mcp.transform` (`draft.set(name, adaptMcpServer(cfg))` for
     the built-in MCPs; v2 ≥ #45408, see below)
   - `command` → `ctx.command.transform` — v2 command drafts are add-only:
     `draft.add({name, description, execute})`. `execute` submits a
     `<omos-cmd-command data-name="...">` marker as a user prompt; the session
     context hook recovers it and dispatches to the v1
     `command.execute.before` hook (deepwork/reflect/loop)
   - a single `ctx.session.hook("context")` handles the system/messages
     transforms (SystemPart[]/Message.content shape conversion),
     `chat.message` agent tracking, and interview + generic command marker
     dispatch — mutating only the trailing message so earlier content stays
     byte-identical (provider prompt-cache prefix reuse)
   - `tool.execute.before/after` → `ctx.tool.hook` via
     `createToolExecuteBridges` (`src/v2/setup.ts`): the host `subagent` tool
     is normalized to v1 `task` semantics (name mapping, `agent`→
     `subagent_type`, `sessionID`→`task_id`, and back after the hook so v2
     executes the repaired input). A throwing `execute.before` **rethrows** —
     v2 rejects the tool call, which is how the v1 anti-duplicate /
     relaunch-lease guards enforce on v2
   - `event` → `ctx.event.subscribe()` loop feeding `mapV2EventToV1`
     (`src/v2/event-adapter.ts`): additive synthesis only — the raw v2 event
     is always dispatched first (the interview bridge depends on it), then
     synthesized v1 shapes: idle `session.status` → `session.idle`, flat
     child `session.created` → v1 early-registration
     `{info: {id, parentID, agent?}}`, and usage telemetry
     (`session.usage.updated`/`session.step.ended`) → a deduplicated
     completed-assistant `message.updated` for the cache monitor
   - `generate.text` → one-shot generation channel probed on `ctx.generate`
     and threaded as `experimental_v2.generateText`, powering the webfetch
     secondary-model summaries without a temp session
   - `dispose` → returned cleanup

Each bridge is independently try/catch-guarded so one failure cannot disable
the rest, and a zero-registration load logs a loud health-check warning.

## Feature matrix

| Capability | v1 (`opencode`) | v2 (`opencode2`) | Minimum v2 capability / degradation |
|---|---|---|---|
| Orchestrator + specialist agents, prompts & permission mapping | ✅ | ✅ `ctx.agent.transform` | — |
| Delegation + background job board + `task_*` tools | ✅ `task` tool | ✅ host `subagent` (auto-bridged: name/args normalization in `src/v2/delegation.ts`, output parsing in the execute bridges) | — |
| Tools (ast-grep, webfetch, task_message/task_cancel/task_revive, wait_for_user, acp_run) | ✅ | ✅ `ctx.tool.transform` | ast-grep needs its CLI binary (package, system, or lazy download); webfetch needs `jsdom` resolvable |
| Slash commands `/deepwork` `/reflect` `/loop` | ✅ | ✅ marker round-trip | command `execute` callbacks ≥ `beta-18269`; older builds register no commands |
| `/interview` | ✅ | ✅ marker command + trailing-message context bridge | — |
| Message transforms (phase reminder, skills filter, image routing, display-name rewrite) | ✅ | ✅ via the single context hook | — |
| Event handling (session tracking, lifecycle, cache telemetry) | ✅ | ✅ event pump + additive v2→v1 synthesis | — |
| Tool execute hooks (apply-patch recovery, task-session, json-recovery) | ✅ | ✅ `createToolExecuteBridges` with subagent→task normalization | — |
| Built-in MCPs (context7, gh_grep) auto-registered | ✅ | ✅ `ctx.mcp.transform` | `mcp.transform` ≥ #45408; older builds degrade to config-only — see [the snippet](#restoring-built-in-mcps-on-older-v2-builds) |
| webfetch secondary-model summaries | ✅ | ✅ via `ctx.generate.text` | absent → secondary-model summaries are unavailable (logged) |
| Foreground model fallback (rate-limit failover) | ✅ | ✅ shim translates re-prompt into `session.switchModel` + `delivery:"steer"` prompt | `switchModel` ≥ #43718; older builds steer on the current model with an honest log (fallback inactive) |
| `/preset` (interactive switcher) | ✅ | ✅ TUI plugin entry (`./tui` → `dist/tui2.js`): sidebar + `/preset` dialog or `/preset <name>` fast path | TUI host needs `keymap.layer` + `ui.dialog.select`; config-file `preset` still applies at load |
| Project directory | ✅ | ✅ `ctx.location.directory` | ≥ #45403; older builds use `process.cwd()` |
| TUI default agent | ✅ orchestrator | ✅ orchestrator — `draft.default("orchestrator")`; recent v2 TUI builds honor `default_agent` and hoist the default to the head of the agent list | needs a recent v2 build |
| Multiplexer (tmux/zellij/herdr/cmux panes) | ✅ | ❌ host-gated off (`hostFlavor: 'v2'` → `shouldEnableMultiplexer` returns false and the session manager is forced to `type: "none"`) | by design — v2 renders subagents natively |
| Orchestrator-wake scheduler | ✅ | ❌ evaluated, intentionally not ported | v2's built-in `subagent` tool posts completion notifications to the parent natively, which covers the wake scheduler's job; see [Limitations](#limitations) |
| `chat.headers` (custom request headers) | ✅ | ❌ unbridged | low value: v2 exposes an HTTP request hook (`session.hook("http.request")`) — will bridge only if asked for |
| Companion app | ✅ | ⚠️ unverified | independent desktop app; test separately against v2 |

## Capability floors and version policy

v2 moves fast and beta numbers are CI build IDs, so floors are stated as
upstream PR/commit references rather than versions:

| Feature | Floor | Older-build behavior |
|---|---|---|
| Programmatic MCP registration (`ctx.mcp.transform`) | ≥ #45408 | MCPs stay config-only (logged); add them manually with [the snippet](#restoring-built-in-mcps-on-older-v2-builds) |
| Foreground model switch (`ctx.session.switchModel`) | ≥ #43718 | re-prompt steers on the current model (logged) — rate-limit failover inactive |
| Project directory (`ctx.location`) | ≥ #45403 | resolved from `process.cwd()` — run `opencode2` from your project root |
| Command `execute` callbacks (add-only drafts) | ≥ `beta-18269` | slash commands do not register |

Every v2 API the adapter touches is capability-probed at runtime
(`typeof ctx.mcp?.transform === 'function'`, `s.switchModel`, `ctx.generate`,
…), so one missing capability degrades that single feature with a log line
instead of breaking the load.

### Pin your plugin version on v2

v2 **auto-refreshes unpinned npm plugins on every startup** (#45118) —
`"oh-my-opencode-slim@latest"` effectively means "silently upgrade whenever a
new version ships". During the current rapid-evolution window (both v2 and
this adapter are changing quickly), pin an exact version:

```json
{
  "plugin": ["oh-my-opencode-slim@2.2.17"]
}
```

and bump it deliberately. The plugin logs its active capability set on load,
so a pinned older build behaves exactly the same tomorrow as it does today.

## Known upstream behaviors

Behaviors of v2 itself that plugin authors should know about — none currently
break this plugin:

- **MCP tool namespace casing** (#45618): v2 changed the casing of generated
  MCP tool-name namespaces. **Safe here** — neither the adapters nor the hooks
  match raw MCP tool names; MCP access is granted per server name
  (`"mcps": ["context7", "!gh_grep"]` in agent config), and the registration
  uses our own server names via `draft.set(name, ...)`.
- **`tool.execute.before` carries no `inputSchema`**: the v2 before-hook
  event has no tool schema. We don't consume one — the bridge passes a mutable
  `args` view and writes back what hooks produce.
- **Command `execute` receives a prompt *object*, not a string**: v2 hands
  the handler a `PromptInput.Prompt`. The command bridge reads `.text`
  (`invocation?.prompt?.text ?? ''`) and never assumes a string.
- **Duplicate idle delivery.** v2 deprecated `session.idle` in favor of
  `session.status`; the adapter synthesizes `session.idle` additively, so an
  idle-tolerant consumer watching both events sees idle twice per session.
  Current consumers are idempotent per session (idle-reconciliation's
  per-session timer guards); new idle consumers must tolerate duplicate
  delivery.

## Installing on v2

Add to `~/.config/opencode2/opencode.json`:

```json
{
  "plugin": ["oh-my-opencode-slim@2.2.17"]
}
```

(Pin the exact current version — see
[version policy](#capability-floors-and-version-policy).)

For local development, point at the built `dist/server.js` directly:

```json
{
  "plugin": ["/path/to/oh-my-opencode-slim/dist/server.js"]
}
```

Then build:

```bash
bun install
bun run build   # produces dist/index.js (v1), dist/server.js (v2 server),
                # dist/tui2.js (v2 TUI), dist/cli/
```

Verify with `opencode2 run "list your specialist agents" --standalone` — the
orchestrator should name explorer, librarian, oracle, designer, fixer.

## Configuring models on v2

Agent models are resolved the same way as v1 (per-agent `model` in
`oh-my-opencode-slim.json`, or inherited from the session/host default). On v2,
set a working provider+model in your v2 config or the plugin's config file so
delegated subagents can run.

Rate-limit fallback works on v2 builds with `switchModel` (≥ #43718): when the
foreground model hits a rate limit, the plugin switches the session's model and
steers the re-prompt through `delivery: "steer"`. On older builds the fallback
stays inactive and logs honestly — switch the model manually there.

## Restoring built-in MCPs on older v2 builds

On v2 builds without `ctx.mcp.transform` (< #45408) the two built-in remote
MCPs are not auto-registered. They are plain remote URLs — copy this into your
`~/.config/opencode2/opencode.json` to restore them:

```json
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "$CONTEXT7_API_KEY" }
    },
    "gh_grep": { "type": "remote", "url": "https://mcp.grep.app" }
  }
}
```

(`context7` needs `CONTEXT7_API_KEY`; `gh_grep` needs nothing. Drop either key
if unused.) The librarian agent uses these for library-docs lookup and
GitHub-wide code search; without them it still works via `webfetch`.

## Limitations

### Interview

`/interview` is supported on v2 through a marker command and a trailing-message
context bridge. The bridge keeps an in-memory transcript projection from v2
context and streamed text events, and uses the v2 session methods for prompts,
notifications, and renames. The markdown document remains the durable source
of truth; completion responses without `<interview_state>` rewrite the current
spec while retaining frontmatter and Q&A history.

### v1-only, by design

- **Multiplexer panes.** tmux/zellij/herdr integration is a v1-TUI feature;
  v2 renders subagents natively, so the multiplexer is host-gated off on v2
  (`shouldEnableMultiplexer` / `sessionManagerMultiplexerConfig` in
  `src/index.ts`).
- **Orchestrator-wake scheduler** (`backgroundJobs.orchestratorWake`).
  Evaluated and intentionally not ported: the scheduler's job — nudging an
  idle parent with unfinished work — is covered on v2 by the host's built-in
  `subagent` tool, which posts completion notifications to the parent session
  natively (verified in the v2 source: `notifyWhenDone` in
  `packages/core/src/tool/plugin/subagent.ts` sends a
  `session.synthetic` message with a `<subagent sessionID state …>`
  envelope to the parent). The capability stays v1-only (it also requires
  host `todo`/`children` surfaces — and the v1 live session-`status` map —
  that the v2 shim does not provide).
- **`chat.headers`.** Not bridged (low value on v2 — an HTTP request hook
  exists if demand appears).

### Environment caveats

- **Reduced/TUI-side hosts.** Some host processes load the plugin's `setup`
  with a reduced, TUI-side context that lacks `agent.transform` (and other
  domains). The adapter capability-guards `setup` and skips registration
  gracefully for those hosts instead of crashing or retry-storming.
- **Path-based dev loading.** When v2 loads the plugin by absolute file path it
  appends a `?mtime=` cache-busting query, which can break resolution of the
  externalized `jsdom` import from the plugin's `node_modules`. The plugin still
  loads because webfetch imports it lazily; install as a package or ensure
  `jsdom` is resolvable to enable webfetch locally. AST-grep resolves its CLI
  independently and lazily downloads a binary when no package or system binary
  is available.
- **Companion app unverified on v2.** The companion is an independent desktop
  app; test it separately against v2 hosts.
- **Prompt-cache rules unchanged.** The v2 bridges reuse the v1 transform
  pipeline under the same cache-safety contract: only trailing messages are
  mutated, earlier content stays byte-identical, and the v1 enforcement suite
  (`src/hooks/cache-safety.property.test.ts` and friends) covers the shared
  transform code the v2 context hook invokes.
