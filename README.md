# Symphony

Symphony is an adaption of OpenAI's Symphony which provides a long-running automation service that orchestrates coding agents (Claude Code or Gemini) to work on software issues across multiple repositories. It continuously polls Linear for eligible issues, routes each one to the correct repository, creates an isolated workspace, and runs an AI agent to implement the fix — automatically creating a pull request and moving the issue to Done when complete.

## How It Works

1. Symphony polls your Linear project on a fixed interval
2. Eligible issues (in configured active states, not blocked) are dispatched to Coding agents
3. Each issue gets a dedicated workspace directory on disk
4. Before each agent run, workspace hooks clone/sync your repository
5. Coding Agent works on the issue following your `WORKFLOW.md` prompt
6. On completion, Symphony checks if the issue is still active and re-dispatches if needed
7. On failure, it retries with exponential backoff

## Agents and Coordination

### One subprocess per issue

Each dispatched issue gets exactly one agent process running at a time. If 3 issues are in progress simultaneously, there are 3 agent subprocesses running — each in its own workspace directory, completely isolated from the others.

```
Symphony (Node.js process)
├── agent subprocess → ~/symphony_workspaces/PROJ-42/
├── agent subprocess → ~/symphony_workspaces/PROJ-43/
└── agent subprocess → ~/symphony_workspaces/PROJ-44/
```

### Coordination is entirely in Symphony

There is no agent-to-agent communication. Subprocesses don't know about each other. All coordination happens in Symphony's orchestrator — a single Node.js event loop maintaining in-memory state:

- **`claimed`** — set of issue IDs reserved to prevent double-dispatch
- **`running`** — map of issue ID → live subprocess metadata (PID, session ID, token counts, last event timestamp)
- **`retry_attempts`** — map of issue ID → scheduled retry timer

Before dispatching any issue, Symphony checks both `claimed` and `running`. Since Node.js is single-threaded, these checks are race-condition-free — no locking needed.

### Concurrency limits

Controlled by `orchestrator.max_concurrent_agents` (default: 5).

```yaml
orchestrator:
  max_concurrent_agents: 5
```

### Each session is bounded by `max_turns`

A single agent subprocess runs until it finishes, hits `max_turns`, times out, or stalls. When it exits normally, Symphony moves the Linear issue to Done and creates a pull request via the `after_run` hook.

```
Issue PROJ-42 lifecycle:
  Session 1 (attempt=null):  agent runs → exits
  Symphony: success → run after_run hook (git push + gh pr create)
                    → move Linear issue to Done
         or failure → retry with exponential backoff
```

The `attempt` variable in the prompt template lets you give the agent different instructions on retry runs — e.g. "check the current state of the workspace and resume" instead of starting from scratch.

### What each subprocess does independently

Once launched, each agent subprocess:
- Has its own API connection (Anthropic or Google)
- Has its own tool call budget (`max_turns`)
- Reads and writes only within its workspace directory
- Emits events back to Symphony (token counts, tool calls, stop reason)

Symphony reads that stream to update live session state and detect stalls, but does not intervene in what the agent decides to do within a session.

## Prerequisites

**Required for all setups:**
- [Node.js](https://nodejs.org) 18+
- [git](https://git-scm.com) on your PATH (`git --version`)
- [GitHub CLI](https://cli.github.com) (`gh`) authenticated to your GitHub account — used by the `after_run` hook to create pull requests (`gh auth login`)
- A [Linear](https://linear.app) account with an API key

**For the Claude backend** (`agent.backend: claude`):
- [Claude Code CLI](https://claude.ai/code) installed and authenticated (`claude --version`)
- A Claude Pro subscription or [Anthropic API key](https://console.anthropic.com)

**For the Gemini backend** (`agent.backend: gemini`):
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`npm install -g @google/gemini-cli`)
- A [Google AI Studio API key](https://aistudio.google.com/apikey) — free tier gives 20 requests/day per key; add multiple keys via `key_pool` to rotate through them automatically

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

For the Claude backend:
```bash
export LINEAR_API_KEY=lin_api_...
export ANTHROPIC_API_KEY=sk-ant-...   # or omit if using Claude Pro via OAuth
```

For the Gemini backend:
```bash
export LINEAR_API_KEY=lin_api_...
export GEMINI_API_KEY=AIzaSy...       # primary key
export GEMINI_KEY_2=AIzaSy...         # optional additional keys for rotation
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
  backend: linear
  linear:
    api_key: $LINEAR_API_KEY
    done_state: Done

projects:
  - name: "My Project"
    linear_project_slug: "your-slug-here"
    repo_url: "https://github.com/your-org/your-repo.git"
    target_branch: "main"

workspace:
  root: ~/symphony_workspaces

agent:
  backend: claude

claude:
  api_key: $ANTHROPIC_API_KEY
---

Work on issue {{issue.identifier}}: {{issue.title}}.

{{issue.description}}
```

### Full Example

See [`WORKFLOW.md.example`](WORKFLOW.md.example) for a complete annotated example including hooks, concurrency settings, and a detailed prompt template.

## Configuration Reference

### `tracker`

Controls which Linear project Symphony watches.

| Field | Default | Description |
|---|---|---|
| `backend` | `linear` | Currently only `linear` is supported. |
| `linear.api_key` | `$LINEAR_API_KEY` | Linear API key. Use `$VAR` to read from environment. |
| `linear.active_states` | `Todo, To Do, In Progress, Triage` | Issues in these states are eligible for dispatch. |
| `linear.done_state` | `Done` | State to move issues to when an agent completes successfully. |

### `projects`

Maps Linear project slugs to GitHub repositories. Each entry defines one project.

| Field | Description |
|---|---|
| `name` | Display name (used in logs). |
| `linear_project_slug` | The Linear project `slugId` (from the project URL). |
| `repo_url` | GitHub repository URL, e.g. `https://github.com/your-org/your-repo.git`. |
| `target_branch` | Branch to clone and create PRs against (e.g. `main`). |

### `orchestrator`

| Field | Default | Description |
|---|---|---|
| `polling_interval_ms` | `30000` | How often (ms) Symphony polls Linear for new work. |
| `max_concurrent_agents` | `5` | Maximum number of agent sessions running at once. |
| `max_attempts` | `3` | Maximum retry attempts before giving up on a failing issue. |
| `max_retry_backoff_ms` | `300000` (5 min) | Cap on exponential retry backoff delay. |

### `workspace`

| Field | Default | Description |
|---|---|---|
| `root` | `<cwd>/workspaces` | Directory where per-issue workspace folders are created. Supports `~`. |

Each issue gets a subdirectory named after its identifier (e.g. `~/symphony_workspaces/PROJ-123/`).

### `hooks`

Shell scripts that run before and after each agent session. Each hook runs in the workspace directory. Hook scripts support template variables: `{{issue_identifier}}`, `{{issue_title}}`, `{{repo_url}}`, `{{repo_name}}`, `{{target_branch}}`, `{{agent_summary}}`.

| Field | When it runs | On failure |
|---|---|---|
| `before_run` | Before every agent session | Fatal — aborts the current attempt |
| `after_run` | After every agent session | Logged and ignored |
| `timeout_ms` | — | Default `300000` (5 min). Applies to all hooks. |

### `agent`

| Field | Default | Description |
|---|---|---|
| `backend` | `gemini` | Which agent to use: `gemini` or `claude`. |

### `claude`

Controls how the Claude Code CLI is invoked.

| Field | Default | Description |
|---|---|---|
| `api_key` | `$ANTHROPIC_API_KEY` | Anthropic API key (optional if using Claude Pro OAuth). |
| `model` | CLI default | Model to use, e.g. `claude-sonnet-4-6`, `claude-opus-4-7`. |
| `permission_mode` | `bypassPermissions` | Permission mode: `bypassPermissions`, `acceptEdits`, `default`. |
| `allowed_tools` | (all) | Comma-separated list of tools Claude may use, e.g. `Bash,Read,Write,Edit`. |
| `disallowed_tools` | (none) | Tools to explicitly block. |
| `max_turns` | `20` | Maximum agentic turns per session. |
| `system_prompt` | (none) | Optional system prompt prepended to every session. |
| `turn_timeout_ms` | `3600000` (1 hour) | Wall-clock timeout for a single session. |
| `stall_timeout_ms` | `300000` (5 min) | If no output is received for this long, the session is killed and retried. |

### `gemini`

Controls how the Gemini CLI is invoked.

| Field | Default | Description |
|---|---|---|
| `api_key` | `$GEMINI_API_KEY` | Primary Google AI Studio API key. |
| `key_pool` | `[]` | Additional API keys to rotate through when quota is exhausted (round-robin). |
| `model` | `gemini-2.5-flash` | Model to use. |
| `output_format` | `json` | `json` gives token usage info; `text` for plain output. |
| `turn_timeout_ms` | `3600000` (1 hour) | Wall-clock timeout for a single session. |
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

## Multiple Projects

A single Symphony instance can manage multiple repositories. Add each project to the `projects:` array in `WORKFLOW.md`, mapping its Linear project slug to its GitHub repo URL:

```yaml
projects:
  - name: "Backend API"
    linear_project_slug: "abc123def456"
    repo_url: "https://github.com/your-org/backend.git"
    target_branch: "main"

  - name: "Frontend App"
    linear_project_slug: "789xyz000111"
    repo_url: "https://github.com/your-org/frontend.git"
    target_branch: "main"
```

Symphony automatically routes each Linear issue to the correct repository based on which project it belongs to. The `before_run` and `after_run` hooks receive `{{repo_url}}`, `{{repo_name}}`, and `{{target_branch}}` variables so a single hook definition works for all projects.

**Finding your project slug:** Open your Linear project and look at the URL:
```
https://linear.app/your-org/project/my-project-abc123/...
                                     ^^^^^^^^^^^^^^^^
                                         slugId
```

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
- Agent settings (model, timeout, tools)
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
| `HTTP 400 from Linear API` | Invalid GraphQL query — check `linear_project_slug` is correct |
| `Credit balance is too low` | Add credits at console.anthropic.com; verify the API key belongs to the right workspace |
| `You have exhausted your capacity on this model` | Gemini free-tier quota exhausted — add more keys to `key_pool` or wait for daily reset |
| `before_run hook failed exit_code=128` | Hook script error — check stderr in the log; often a git authentication issue |
| Issue dispatched then immediately released | Issue moved out of active states in Linear |
| Agent keeps retrying with backoff | Check for `turn_failed` or `startup_failed` events in debug logs (`LOG_LEVEL=debug`) |
| `Claude Code cannot be launched inside another Claude Code session` | `CLAUDECODE` env var leaked into the subprocess — this is handled automatically by Symphony |
| PRs failing with `No commits between main and agent/...` | Agent ran but made no code changes — check the issue description is specific enough |
