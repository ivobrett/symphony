# Symphony

Symphony is a long-running automation service that orchestrates Claude Code agents to work on software issues. It continuously polls a Linear project for eligible issues, creates isolated per-issue workspaces, and runs a Claude Code CLI session for each one — automatically retrying on failure and picking up new work as it appears.

## How It Works

1. Symphony polls your Linear project on a fixed interval
2. Eligible issues (in configured active states, not blocked) are dispatched to Claude Code agents
3. Each issue gets a dedicated workspace directory on disk
4. Before each agent run, workspace hooks clone/sync your repository
5. Claude Code works on the issue following your `WORKFLOW.md` prompt
6. On completion, Symphony checks if the issue is still active and re-dispatches if needed
7. On failure, it retries with exponential backoff

## Agents and Coordination

### One subprocess per issue

Each dispatched issue gets exactly one `claude` CLI process running at a time. If 3 issues are in progress simultaneously, there are 3 `claude` subprocesses running — each in its own workspace directory, completely isolated from the others.

```
Symphony (Node.js process)
├── claude subprocess → ~/symphony_workspaces/PROJ-42/
├── claude subprocess → ~/symphony_workspaces/PROJ-43/
└── claude subprocess → ~/symphony_workspaces/PROJ-44/
```

### Coordination is entirely in Symphony

There is no agent-to-agent communication. The `claude` subprocesses don't know about each other. All coordination happens in Symphony's orchestrator — a single Node.js event loop maintaining in-memory state:

- **`claimed`** — set of issue IDs reserved to prevent double-dispatch
- **`running`** — map of issue ID → live subprocess metadata (PID, session ID, token counts, last event timestamp)
- **`retry_attempts`** — map of issue ID → scheduled retry timer

Before dispatching any issue, Symphony checks both `claimed` and `running`. Since Node.js is single-threaded, these checks are race-condition-free — no locking needed.

### Concurrency limits

Controlled by `agent.max_concurrent_agents` (default: 10). You can also set per-state limits:

```yaml
agent:
  max_concurrent_agents: 5
  max_concurrent_agents_by_state:
    In Progress: 2   # at most 2 issues in "In Progress" at once
    Todo: 3          # at most 3 in "Todo"
```

### Each session is bounded by `max_turns`

A single `claude` subprocess runs until it finishes, hits `max_turns`, times out, or stalls. When it exits normally, Symphony schedules a 1-second continuation — it re-fetches the issue from Linear, and if it's still active, starts a new subprocess in the same workspace. This is how long-running issues are handled across multiple Claude sessions without one subprocess running indefinitely.

```
Issue PROJ-42 lifecycle:
  Session 1 (attempt=null):  claude runs up to 30 turns → exits
  Symphony: issue still active? yes → schedule continuation in 1s
  Session 2 (attempt=1):     claude runs up to 30 turns → exits
  Symphony: issue still active? no (moved to Done) → release, clean workspace
```

The `attempt` variable in the prompt template lets you give the agent different instructions on continuation runs — e.g. "check the current state of the workspace and resume" instead of starting from scratch.

### What each subprocess does independently

Once launched, each `claude` subprocess:
- Has its own API connection to Anthropic
- Has its own tool call budget (`max_turns`)
- Reads and writes only within its workspace directory
- Streams JSON events back to Symphony (token counts, tool calls, stop reason)

Symphony reads that stream to update live session state and detect stalls, but does not intervene in what Claude decides to do within a session.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Claude Code CLI](https://claude.ai/code) installed and on your PATH (`claude --version`)
- A [Linear](https://linear.app) account with an API key
- An [Anthropic API key](https://console.anthropic.com) with available credits

## Installation

```bash
git clone https://github.com/obelix74/symphony.git
cd symphony
npm install
```

## Quick Start

**1. Create your `WORKFLOW.md`**

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

Edit `WORKFLOW.md` with your project details (see [Configuration](#configuration) below).

**2. Set environment variables**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export LINEAR_API_KEY=lin_api_...
```

**3. Run**

```bash
npm start
```

With the web dashboard:

```bash
npm start -- --port 8080
# open http://localhost:8080
```

With a custom workflow file:

```bash
npm start -- --workflow ~/projects/my-repo/WORKFLOW.md --port 8080
```

## WORKFLOW.md

`WORKFLOW.md` is the single configuration file that controls everything: which Linear project to watch, how to set up workspaces, how to invoke Claude Code, and what prompt to give the agent for each issue.

It is a Markdown file with a YAML front matter block followed by a [Liquid](https://liquidjs.com/) prompt template.

**It is intentionally not committed to the Symphony repo** — keep a separate `WORKFLOW.md` inside each project repository you want Symphony to work on, and point Symphony at it with `--workflow`.

### Minimal Example

```markdown
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project-abc123

claude:
  api_key: $ANTHROPIC_API_KEY
---

Work on issue {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}
```

### Full Example

See [`WORKFLOW.md.example`](WORKFLOW.md.example) for a complete annotated example including hooks, concurrency settings, and a detailed prompt template.

## Configuration Reference

### `tracker`

Controls which Linear project Symphony watches.

| Field | Default | Description |
|---|---|---|
| `kind` | — | Required. Currently only `linear` is supported. |
| `api_key` | `$LINEAR_API_KEY` | Linear API key. Use `$VAR` to read from environment. |
| `project_slug` | — | Required. The Linear project `slugId` (from the project URL). |
| `active_states` | `Todo, In Progress` | Issues in these states are eligible for dispatch. |
| `terminal_states` | `Done, Cancelled, Canceled, Duplicate, Closed` | Issues in these states cause running agents to be stopped and workspaces cleaned up. |

**Finding your project slug:** Open your Linear project and look at the URL:
```
https://linear.app/your-org/project/my-project-abc123/...
                                     ^^^^^^^^^^^^^^^^
                                         slugId
```

### `polling`

| Field | Default | Description |
|---|---|---|
| `interval_ms` | `30000` | How often (ms) Symphony polls Linear for new work. |

### `workspace`

| Field | Default | Description |
|---|---|---|
| `root` | `<tmpdir>/symphony_workspaces` | Directory where per-issue workspace folders are created. Supports `~` and `$VAR`. |

Each issue gets a subdirectory named after its identifier (e.g. `~/symphony_workspaces/PROJ-123/`). Workspaces persist across agent sessions for the same issue.

### `hooks`

Shell scripts that run at key points in the workspace lifecycle. Each hook runs in the workspace directory via `sh -lc`.

| Field | When it runs | On failure |
|---|---|---|
| `after_create` | Once, when the workspace directory is first created | Fatal — aborts workspace creation |
| `before_run` | Before every agent session | Fatal — aborts the current attempt |
| `after_run` | After every agent session (success or failure) | Logged and ignored |
| `before_remove` | Before a workspace is deleted (terminal issue) | Logged and ignored |
| `timeout_ms` | — | Default `60000`. Applies to all hooks. |

**Recommended `before_run` pattern** for a GitHub-hosted repository:

```yaml
hooks:
  before_run: |
    set -e
    REPO_URL="https://github.com/your-org/your-repo.git"
    if [ ! -d .git ] || ! git remote get-url origin 2>/dev/null | grep -qF "your-org/your-repo"; then
      find . -mindepth 1 -delete 2>/dev/null || true
      git clone "$REPO_URL" .
    fi
    git fetch origin
    git reset --hard origin/main
  timeout_ms: 120000
```

This self-heals from partial clones: if `.git` is missing or points at the wrong remote, it wipes the directory and re-clones before every run.

### `agent`

| Field | Default | Description |
|---|---|---|
| `max_concurrent_agents` | `10` | Maximum number of Claude Code sessions running at once. |
| `max_retry_backoff_ms` | `300000` (5 min) | Cap on exponential retry backoff delay. |
| `max_concurrent_agents_by_state` | `{}` | Per-state concurrency limits, e.g. `In Progress: 2`. |

### `claude`

Controls how the Claude Code CLI is invoked.

| Field | Default | Description |
|---|---|---|
| `command` | `claude` | The Claude Code CLI binary. |
| `model` | CLI default | Model to use, e.g. `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`. |
| `permission_mode` | `bypassPermissions` | Permission mode: `bypassPermissions`, `acceptEdits`, `default`. |
| `allowed_tools` | (all) | Comma-separated list of tools Claude may use, e.g. `Bash,Read,Write,Edit,Glob,Grep`. |
| `disallowed_tools` | (none) | Tools to explicitly block. |
| `max_turns` | `20` | Maximum agentic turns per CLI invocation. |
| `api_key` | `$ANTHROPIC_API_KEY` | Anthropic API key. Use `$VAR` to read from environment. |
| `system_prompt` | (none) | Optional system prompt prepended to every session. |
| `turn_timeout_ms` | `3600000` (1 hour) | Wall-clock timeout for a single Claude Code session. |
| `stall_timeout_ms` | `300000` (5 min) | If no output is received for this long, the session is killed and retried. |

### `server` (optional)

| Field | Default | Description |
|---|---|---|
| `port` | (disabled) | If set, starts the HTTP dashboard on this port. Also configurable via `--port` CLI flag. |

## Prompt Template

The Markdown body of `WORKFLOW.md` (after the `---` front matter block) is the prompt template. It is rendered using [Liquid](https://liquidjs.com/) with the following variables:

| Variable | Type | Description |
|---|---|---|
| `issue.id` | string | Linear internal issue ID |
| `issue.identifier` | string | Human-readable key, e.g. `PROJ-42` |
| `issue.title` | string | Issue title |
| `issue.description` | string or null | Issue description body |
| `issue.state` | string | Current Linear state name |
| `issue.priority` | integer or null | Priority (1=urgent, 2=high, 3=medium, 4=low, null=none) |
| `issue.labels` | array of strings | Labels (lowercased) |
| `issue.url` | string or null | Linear issue URL |
| `issue.branch_name` | string or null | Git branch name suggested by Linear |
| `issue.blocked_by` | array | Blocking issues with `id`, `identifier`, `state` fields |
| `attempt` | integer or null | `null` on first run; `1+` on continuation/retry |

Use `attempt` to give the agent different instructions when resuming:

```liquid
{% if attempt %}
A previous session ran on this workspace. Check the current state of
the codebase and resume work — do not start from scratch.
{% endif %}
```

Unknown variables or filters cause the run to fail immediately (strict mode).

## CLI Options

```
npm start -- [options]

Options:
  --workflow, -w <path>   Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --port <n>              Enable HTTP dashboard on this port
  --help, -h              Show help

Environment:
  ANTHROPIC_API_KEY       Anthropic API key (if not hardcoded in WORKFLOW.md)
  LINEAR_API_KEY          Linear API key (if not hardcoded in WORKFLOW.md)
  LOG_LEVEL               trace | debug | info | warn | error (default: info)
```

## HTTP Dashboard

When `--port` is set (or `server.port` is set in `WORKFLOW.md`), Symphony starts a local HTTP server.

| Endpoint | Description |
|---|---|
| `GET /` | Human-readable dashboard (auto-refreshes every 10s) |
| `GET /api/v1/state` | JSON snapshot of all running sessions, retry queue, token totals |
| `GET /api/v1/<identifier>` | JSON details for a specific issue (e.g. `/api/v1/PROJ-42`) |
| `POST /api/v1/refresh` | Trigger an immediate poll cycle |

The dashboard binds to `127.0.0.1` only.

## Running Multiple Repos

Run a separate Symphony instance per repository, each with its own `WORKFLOW.md` and port:

```bash
# Terminal 1
npm start -- --workflow ~/projects/repo-a/WORKFLOW.md --port 8080

# Terminal 2
npm start -- --workflow ~/projects/repo-b/WORKFLOW.md --port 8081
```

Or set `server.port` in each repo's `WORKFLOW.md` and omit the `--port` flag.

## Dispatch Eligibility

An issue is picked up by Symphony only if **all** of the following are true:

- It has an `id`, `identifier`, `title`, and `state`
- Its state is in `tracker.active_states` and not in `tracker.terminal_states`
- It is not already running or queued for retry
- A concurrency slot is available (global and per-state limits)
- If the issue state is `Todo`: none of its blockers are in a non-terminal state

Issues are prioritized by: Linear priority (urgent first) → oldest created first → identifier alphabetically.

## Retry Behavior

| Scenario | Delay |
|---|---|
| Agent completed normally | 1 second (re-checks if issue still needs work) |
| Agent failed / timed out / stalled | `min(10s × 2^attempt, max_retry_backoff_ms)` |

Retries stop if the issue is no longer found in active states when the timer fires.

## Hot Reload

Symphony watches `WORKFLOW.md` for changes and re-applies configuration live without restart. The following take effect immediately:

- Poll interval
- Concurrency limits
- Active/terminal states
- Hook scripts
- Claude settings (model, timeout, tools)
- Prompt template (for future runs)

In-flight agent sessions are not interrupted when config changes.

## Operator Controls

| Action | Effect |
|---|---|
| Edit `WORKFLOW.md` | Config and prompt reloaded live |
| Move issue to a terminal state in Linear | Running agent is stopped and workspace is cleaned up |
| Move issue to a non-active, non-terminal state | Running agent is stopped (workspace kept) |
| Move issue back to an active state | Symphony dispatches it on the next poll tick |
| `POST /api/v1/refresh` | Trigger an immediate poll without waiting for the next tick |
| Restart Symphony | In-memory state is cleared; issues are re-dispatched from scratch based on Linear state |

## Security Notes

- `WORKFLOW.md` is gitignored in this repo — **do not commit files containing API keys**.
- Use `$VAR` references in `WORKFLOW.md` and export keys from your shell or a secrets manager.
- `bypassPermissions` mode gives Claude Code full access to the workspace filesystem and shell. Only use it in trusted environments. For less trusted setups, use `acceptEdits` and restrict `allowed_tools`.
- Workspace paths are validated to stay within `workspace.root` — agents cannot escape their workspace directory.
- The HTTP dashboard binds to `127.0.0.1` only and is not authenticated. Do not expose it publicly.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `HTTP 400 from Linear API` | Invalid GraphQL query — check `project_slug` is correct |
| `Credit balance is too low` | Add credits at console.anthropic.com; verify the API key belongs to the right workspace |
| `before_run hook failed exit_code=128` | Hook script error — check stderr in the log; often a git issue |
| Issue dispatched then immediately released | Issue moved out of active states in Linear |
| Agent keeps retrying with backoff | Check for `turn_failed` or `startup_failed` events in debug logs (`LOG_LEVEL=debug`) |
| `Claude Code cannot be launched inside another Claude Code session` | `CLAUDECODE` env var leaked into the subprocess — this is handled automatically by Symphony |
