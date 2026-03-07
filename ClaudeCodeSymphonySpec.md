# Symphony Service Specification (Claude Code Edition)

Status: Draft v1 (language-agnostic, Claude Code adaptation)

Purpose: Define a service that orchestrates Claude Code agents to get project work done.

This document is a direct adaptation of the [OpenAI Symphony Specification](https://github.com/openai/symphony/blob/main/SPEC.md) for use with Anthropic's Claude Code CLI instead of OpenAI Codex. The orchestration model, workspace management, and scheduling semantics are preserved exactly. Only the agent integration layer and related configuration have been updated.

## 1. Problem Statement

Symphony is a long-running automation service that continuously reads work from an issue tracker
(Linear in this specification version), creates an isolated workspace for each issue, and runs a
Claude Code agent session for that issue inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations may target trusted environments with a high-trust configuration, while others may
require stricter approvals or sandboxing.

Important boundary:

- Symphony is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links) are typically performed by the coding agent
  using tools available in the workflow/runtime environment.
- A successful run may end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support restart recovery without requiring a persistent database.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in the
  workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Client`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

6. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Launches the Claude Code CLI subprocess.
   - Streams agent updates back to the orchestrator.

7. `Status Surface` (optional)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + agent subprocess)
   - Filesystem lifecycle, workspace preparation, Claude Code CLI protocol.

5. `Integration Layer` (Linear adapter)
   - API calls and normalization for tracker data.

6. `Observability Layer` (logs + optional status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Issue tracker API (Linear for `tracker.kind: linear` in this specification version).
- Local filesystem for workspaces and logs.
- Optional workspace population tooling (for example Git CLI, if used).
- Claude Code CLI (`claude`) that supports `--output-format stream-json` and non-interactive
  (`--print`) mode.
- Host environment authentication for the issue tracker and Claude Code (Anthropic API key).

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable tracker-internal ID.
- `identifier` (string)
  - Human-readable ticket key (example: `ABC-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - Current tracker state name.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- Claude Code CLI executable/args/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (workspace path; current runtime typically uses absolute paths, but relative roots are
  possible if configured without path separators)
- `workspace_key` (sanitized issue identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (optional)

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a Claude Code CLI subprocess is running.

Fields:

- `session_id` (string, assigned from Claude Code `session_id` field in stream events)
- `claude_pid` (integer or null)
- `last_event_type` (string/enum or null)
  - The `type` field of the most recent stream-JSON event.
- `last_event_timestamp` (timestamp or null)
- `last_message` (summarized payload)
- `input_tokens` (integer)
- `output_tokens` (integer)
- `total_tokens` (integer)
- `turn_count` (integer)
  - Number of Claude Code turns started within the current worker lifetime.

#### 4.1.7 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.8 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved/running/retrying)
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `claude_totals` (aggregate tokens + runtime seconds)
- `claude_rate_limits` (latest rate-limit snapshot from agent events)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after `trim` + `lowercase`.
- `Session ID`
  - Read from the `session_id` field emitted in Claude Code stream-JSON events.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with optional YAML front matter.

Design note:

- `WORKFLOW.md` should be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and tracker selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter must decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `claude`

Unknown keys should be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Optional extensions may define additional top-level keys
  (for example `server`) without changing the core schema above.
- Extensions should document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.
- Common extension: `server.port` (integer) enables the optional HTTP server described in Section
  13.7.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - Required for dispatch.
  - Current supported value: `linear`
- `endpoint` (string)
  - Default for `tracker.kind == "linear"`: `https://api.linear.app/graphql`
- `api_key` (string)
  - May be a literal token or `$VAR_NAME`.
  - Canonical environment variable for `tracker.kind == "linear"`: `LINEAR_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
- `project_slug` (string)
  - Required for dispatch when `tracker.kind == "linear"`.
- `active_states` (list of strings or comma-separated string)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings or comma-separated string)
  - Default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer or string integer)
  - Default: `30000`
  - Changes should be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` and strings containing path separators are expanded.
  - Bare strings without path separators are preserved as-is (relative roots are allowed but
    discouraged).

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, optional)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, optional)
  - Runs before each agent attempt after workspace preparation and before launching Claude Code.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, optional)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, optional)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, optional)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Non-positive values should be treated as invalid and fall back to the default.
  - Changes should be re-applied at runtime for future hook executions.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer or string integer)
  - Default: `10`
  - Changes should be re-applied at runtime and affect subsequent dispatch decisions.
- `max_retry_backoff_ms` (integer or string integer)
  - Default: `300000` (5 minutes)
  - Changes should be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`trim` + `lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.3.6 `claude` (object)

Configuration for the Claude Code CLI subprocess.

Fields:

- `command` (string shell command)
  - Default: `claude`
  - The runtime launches this command via `bash -lc` in the workspace directory with additional
    flags appended (see Section 10.1).
  - The launched process must emit line-delimited stream-JSON events on stdout.
- `model` (string)
  - Default: implementation-defined (Claude Code CLI default).
  - Passed as `--model <model>` to the CLI.
  - Example values: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
- `permission_mode` (string)
  - Default: implementation-defined.
  - Passed as `--permission-mode <mode>` to the CLI.
  - Supported values are defined by the targeted Claude Code CLI version. Typical values:
    `default`, `acceptEdits`, `bypassPermissions`.
  - Implementations in trusted environments may use `bypassPermissions` to auto-approve all
    operations.
- `allowed_tools` (list of strings or comma-separated string, optional)
  - Default: empty (all tools permitted by the permission mode).
  - Passed as `--allowedTools <tool,...>` to the CLI.
  - Example: `Bash,Read,Write,Edit,Glob,Grep`.
- `disallowed_tools` (list of strings or comma-separated string, optional)
  - Default: empty.
  - Passed as `--disallowedTools <tool,...>` to the CLI.
- `max_turns` (integer)
  - Default: `20`
  - Passed as `--max-turns <n>` to the CLI.
  - Limits total agentic turns within a single CLI invocation.
- `api_key` (string)
  - May be a literal token or `$VAR_NAME`.
  - Canonical environment variable: `ANTHROPIC_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
  - Injected as `ANTHROPIC_API_KEY` in the subprocess environment.
- `system_prompt` (string, optional)
  - Passed as `--system-prompt <text>` to the CLI to prepend a system-level instruction.
  - If absent, no `--system-prompt` flag is added.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
  - Maximum wall-clock time allowed for a single Claude Code CLI invocation.
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.
  - Inactivity measured by elapsed time since the last received stream-JSON event.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables must fail rendering.
- Unknown filters must fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime may use a minimal default prompt
  (`You are working on an issue from Linear.`).
- Workflow file read/parse failures are configuration/validation errors and should not silently fall
  back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Source Precedence and Resolution Semantics

Configuration precedence:

1. Workflow file path selection (runtime setting -> cwd default).
2. YAML front matter values.
3. Environment indirection via `$VAR_NAME` inside selected YAML values.
4. Built-in defaults.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.

### 6.2 Dynamic Reload Semantics

Dynamic reload is required:

- The software should watch `WORKFLOW.md` for changes.
- On change, it should re-read and re-apply workflow config and prompt template without restart.
- The software should attempt to adjust live behavior to the new config (for example polling
  cadence, concurrency limits, active/terminal states, claude settings, workspace paths/hooks, and
  prompt content for future runs).
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Implementations are not required to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) may
  require restart unless the implementation explicitly supports live rebind.
- Implementations should also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads should not crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- `tracker.api_key` is present after `$` resolution.
- `tracker.project_slug` is present when required by the selected tracker kind.
- `claude.command` is present and non-empty.
- `claude.api_key` is present after `$` resolution (resolved from `ANTHROPIC_API_KEY` by default).

### 6.4 Config Fields Summary (Cheat Sheet)

- `tracker.kind`: string, required, currently `linear`
- `tracker.endpoint`: string, default `https://api.linear.app/graphql` when `tracker.kind=linear`
- `tracker.api_key`: string or `$VAR`, canonical env `LINEAR_API_KEY` when `tracker.kind=linear`
- `tracker.project_slug`: string, required when `tracker.kind=linear`
- `tracker.active_states`: list/string, default `Todo, In Progress`
- `tracker.terminal_states`: list/string, default `Closed, Cancelled, Canceled, Duplicate, Done`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `claude.command`: shell command string, default `claude`
- `claude.model`: string, default implementation-defined (Claude Code CLI default)
- `claude.permission_mode`: string, default implementation-defined
- `claude.allowed_tools`: list/string, default empty
- `claude.disallowed_tools`: list/string, default empty
- `claude.max_turns`: integer, default `20`
- `claude.api_key`: string or `$VAR`, canonical env `ANTHROPIC_API_KEY`
- `claude.system_prompt`: string or null
- `claude.turn_timeout_ms`: integer, default `3600000`
- `claude.stall_timeout_ms`: integer, default `300000`
- `server.port` (extension): integer, optional; enables the optional HTTP server

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.
   - In practice, claimed issues are either `Running` or `RetryQueued`.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

- A successful worker exit does not mean the issue is done forever.
- The orchestrator schedules a short continuation retry (about 1 second) after each normal worker
  exit so it can re-check whether the issue remains active and needs another worker session.
- Unlike the Codex version, each worker session is a single Claude Code CLI invocation bounded by
  `claude.max_turns`. Continuation runs start a new CLI subprocess in the same workspace.
- The first run uses the full rendered task prompt.
- Continuation runs should include context that a prior session completed, not resend the full
  original prompt verbatim (this is controlled by the `attempt` variable in the prompt template).

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `StreamingOutput`
5. `Finishing`
6. `Succeeded`
7. `Failed`
8. `TimedOut`
9. `Stalled`
10. `CanceledByReconciliation`

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`).

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Claude Stream Event`
  - Update live session fields, token counters, and rate limits.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- `claimed` and `running` checks are required before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven (no durable orchestrator DB required).
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval should be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from tracker using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes:
  - If the issue state is `Todo`, do not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).

Retry handling behavior:

1. Fetch active candidate issues (not all issues).
2. Find the specific issue by `issue_id`.
3. If not found, release claim.
4. If found and still candidate-eligible:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active, release claim.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running issue, compute `elapsed_ms` since:
  - `last_event_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > claude.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Tracker state refresh

- Fetch current issue states for all running issue IDs.
- For each running issue:
  - If tracker state is terminal: terminate worker and clean workspace.
  - If tracker state is still active: update the in-memory issue snapshot.
  - If tracker state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue identifier, remove the corresponding workspace directory.
3. If the terminal-issues fetch fails, log a warning and continue startup.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized path)

Per-issue workspace path:

- `<workspace.root>/<sanitized_issue_identifier>`

Workspace persistence:

- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: `issue.identifier`

Algorithm summary:

1. Sanitize identifier to `workspace_key`.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
5. If `created_now=true`, run `after_create` hook if configured.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

### 9.3 Optional Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations may populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- If failure happens while creating a brand-new workspace, implementations may remove the partially
  prepared directory.
- Reused workspaces should not be destructively reset on population failure unless that policy is
  explicitly chosen and documented.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the Claude Code CLI subprocess, validate:
  - `cwd == workspace_path`

Invariant 2: Workspace path must stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.

## 10. Agent Runner Protocol (Claude Code CLI Integration)

This section defines the language-neutral contract for integrating Claude Code as the coding agent.

### 10.1 Launch Contract

The Claude Code CLI is invoked as a subprocess in non-interactive, streaming-JSON mode.

Subprocess launch parameters:

- Command: constructed from `claude.command` plus required flags (see below).
- Invocation: `bash -lc <full_command>` in the workspace directory.
- Working directory: workspace path.
- Stdout: line-delimited stream-JSON events (consumed by the runner).
- Stderr: diagnostic output; not part of the event stream.
- Framing: one JSON object per line on stdout.

Constructed command:

```
<claude.command> \
  --print \
  --output-format stream-json \
  --max-turns <claude.max_turns> \
  [--model <claude.model>] \
  [--permission-mode <claude.permission_mode>] \
  [--allowedTools <claude.allowed_tools>] \
  [--disallowedTools <claude.disallowed_tools>] \
  [--system-prompt <claude.system_prompt>] \
  "<rendered prompt>"
```

Notes:

- `--print` enables non-interactive (headless) mode. Required for subprocess use.
- `--output-format stream-json` causes Claude Code to emit one JSON event object per line on stdout.
- The rendered prompt is passed as the final positional argument or via stdin (see Section 10.2).
- Optional flags (`--model`, `--permission-mode`, etc.) are only included when the corresponding
  config value is set.
- `ANTHROPIC_API_KEY` must be set in the subprocess environment.

Recommended additional process settings:

- Max line size: 10 MB (for safe buffering).

### 10.2 Prompt Delivery

The rendered issue prompt is delivered to Claude Code as a positional argument:

```
claude --print --output-format stream-json ... "<rendered prompt>"
```

For long or complex prompts, implementations may instead pipe the prompt via stdin when the CLI
supports `--print` with stdin input. Implementations should document which delivery mechanism they
use.

Session identifiers:

- Read `session_id` from `system` type events in the stream (field: `session_id`).
- Emit `session_id` to the orchestrator on first receipt.

### 10.3 Stream-JSON Event Protocol

Claude Code emits a sequence of line-delimited JSON objects on stdout when run with
`--output-format stream-json`. Each line is a complete JSON object.

Key event types (the `type` field):

- `system` — lifecycle metadata emitted at startup; contains `session_id` and other session info.
- `assistant` — a content block produced by the model (text, tool_use, etc.).
- `user` — a tool result or user turn injected by the CLI.
- `result` — final turn result; contains `stop_reason`, token usage, and a `cost_usd` field.

Completion conditions:

- A `result` event is received with `stop_reason` set (e.g. `end_turn`, `max_turns`,
  `tool_use` when stalled, or other stop reasons).
- `turn_timeout_ms` wall-clock timeout expires.
- Subprocess exits.

Line handling requirements:

- Read protocol messages from stdout only.
- Buffer partial stdout lines until newline arrives.
- Attempt JSON parse on complete stdout lines.
- Stderr is not part of the protocol stream:
  - Ignore it or log it as diagnostics.
  - Do not attempt protocol JSON parsing on stderr.

### 10.4 Emitted Runtime Events (Upstream to Orchestrator)

The CLI subprocess client emits structured events to the orchestrator callback. Each event should
include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `claude_pid` (if available)
- optional `usage` map (token counts)
- payload fields as needed

Important emitted events may include:

- `session_started`
- `startup_failed`
- `turn_completed` (result event received with successful stop reason)
- `turn_failed` (result event with error stop reason or subprocess error)
- `turn_stalled` (no event received within `stall_timeout_ms`)
- `notification` (assistant text or tool event)
- `other_message`
- `malformed`

### 10.5 Permission Mode and Tool Policy

Permission and tool-access behavior is implementation-defined.

Policy requirements:

- Each implementation should document its chosen permission mode and tool restrictions.
- In high-trust environments, `--permission-mode bypassPermissions` may be used to auto-approve all
  file and shell operations.
- In lower-trust environments, use `--permission-mode default` (or `acceptEdits`) and restrict
  available tools via `--allowedTools` / `--disallowedTools`.
- Claude Code does not have interactive approval dialogs in `--print` mode; any operation that would
  require user confirmation is either auto-approved (based on permission mode) or rejected. Ensure
  the chosen permission mode matches the intended safety posture.

Example high-trust configuration:

```yaml
claude:
  permission_mode: bypassPermissions
  allowed_tools: Bash,Read,Write,Edit,Glob,Grep,WebFetch
```

Example restricted configuration:

```yaml
claude:
  permission_mode: acceptEdits
  allowed_tools: Read,Write,Edit,Glob,Grep
  disallowed_tools: Bash,WebFetch
```

### 10.6 Timeouts and Error Mapping

Timeouts:

- `claude.turn_timeout_ms`: total wall-clock timeout for the subprocess invocation.
- `claude.stall_timeout_ms`: enforced by orchestrator based on event inactivity.

Error mapping (recommended normalized categories):

- `claude_not_found` (CLI binary not on PATH)
- `invalid_workspace_cwd`
- `turn_timeout`
- `stall_timeout`
- `subprocess_exit`
- `turn_failed`
- `prompt_render_failed`

### 10.7 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + CLI subprocess.

Behavior:

1. Create/reuse workspace for issue.
2. Build prompt from workflow template.
3. Launch Claude Code CLI subprocess with constructed flags.
4. Forward stream-JSON events to orchestrator.
5. On any error, fail the worker attempt (the orchestrator will retry).

Note:

- Workspaces are intentionally preserved after successful runs.

## 11. Issue Tracker Integration Contract (Linear-Compatible)

### 11.1 Required Operations

An implementation must support these tracker adapter operations:

1. `fetch_candidate_issues()`
   - Return issues in configured active states for a configured project.

2. `fetch_issues_by_states(state_names)`
   - Used for startup terminal cleanup.

3. `fetch_issue_states_by_ids(issue_ids)`
   - Used for active-run reconciliation.

### 11.2 Query Semantics (Linear)

Linear-specific requirements for `tracker.kind == "linear"`:

- GraphQL endpoint (default `https://api.linear.app/graphql`)
- Auth token sent in `Authorization` header
- `tracker.project_slug` maps to Linear project `slugId`
- Candidate issue query filters project using `project: { slugId: { eq: $projectSlug } }`
- Issue-state refresh query uses GraphQL issue IDs with variable type `[ID!]`
- Pagination required for candidate issues
- Page size default: `50`
- Network timeout: `30000 ms`

### 11.3 Normalization Rules

Candidate issue normalization should produce fields listed in Section 4.1.1.

Additional normalization details:

- `labels` -> lowercase strings
- `blocked_by` -> derived from inverse relations where relation type is `blocks`
- `priority` -> integer only (non-integers become null)
- `created_at` and `updated_at` -> parse ISO-8601 timestamps

### 11.4 Error Handling Contract

Recommended error categories:

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_project_slug`
- `linear_api_request` (transport failures)
- `linear_api_status` (non-200 HTTP)
- `linear_graphql_errors`
- `linear_unknown_payload`
- `linear_missing_end_cursor` (pagination integrity error)

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.

### 11.5 Tracker Writes (Important Boundary)

Symphony does not require first-class tracker write APIs in the orchestrator.

- Ticket mutations (state transitions, comments, PR metadata) are typically handled by Claude Code
  using the MCP tools or Bash commands defined in the workflow prompt.
- If the optional `linear_graphql` client-side tool extension is implemented (see Section 10.5
  extension note), it is part of the agent toolchain via MCP, not orchestrator business logic.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- optional `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` should be passed to the template because the workflow prompt may provide different
instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

Unlike the multi-turn Codex session model, each Claude Code worker is a single CLI invocation
bounded by `claude.max_turns`. Continuation between worker sessions is achieved via the `attempt`
variable — the prompt template should instruct the agent to check the current state of the workspace
and resume work appropriately.

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

Required context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

Required context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

Requirements:

- Operators must be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations may write to one or more sinks.
- If a configured log sink fails, the service should continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (Optional but Recommended)

If the implementation exposes a synchronous runtime snapshot, it should return:

- `running` (list of running session rows, each including `turn_count`)
- `retrying` (list of retry queue rows)
- `claude_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running`
- `rate_limits` (latest Claude API rate limit payload, if available)

### 13.4 Optional Human-Readable Status Surface

A human-readable status surface (terminal output, dashboard, etc.) is optional and
implementation-defined.

If present, it should draw from orchestrator state/metrics only and must not be required for
correctness.

### 13.5 Session Metrics and Token Accounting

Token accounting rules:

- Extract token counts from `result` event fields: `input_tokens`, `output_tokens`, `total_tokens`.
- Accumulate aggregate totals in orchestrator state.
- Track cost from `cost_usd` in `result` events if the implementation surfaces cost data.

Runtime accounting:

- Runtime should be reported as a live aggregate at snapshot/render time.
- Add run duration seconds to the cumulative ended-session runtime when a session ends.

### 13.6 Optional HTTP Server Extension

If implemented:

- Start the HTTP server when a CLI `--port` argument is provided or `server.port` is present in
  `WORKFLOW.md` front matter.
- CLI `--port` overrides `server.port`.
- Bind loopback by default (`127.0.0.1`).

#### 13.6.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- Should depict active sessions, retry delays, token consumption, runtime totals, and health/error
  indicators.

#### 13.6.2 JSON REST API (`/api/v1/*`)

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary of current system state.
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-03-06T10:00:00Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "state": "In Progress",
          "session_id": "session-abc",
          "turn_count": 7,
          "last_event": "assistant",
          "last_message": "Writing tests...",
          "started_at": "2026-03-06T09:50:00Z",
          "last_event_at": "2026-03-06T09:59:00Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "attempt": 3,
          "due_at": "2026-03-06T10:01:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "claude_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details.
  - Returns `404` with `{"error":{"code":"issue_not_found","message":"..."}}` if unknown.

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle.
  - Returns `202 Accepted`.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind or missing tracker credentials/project slug
   - Missing `claude` CLI or missing `ANTHROPIC_API_KEY`

2. `Workspace Failures`
   - Workspace directory creation failure
   - Hook timeout/failure

3. `Agent Session Failures`
   - CLI not found
   - Subprocess exit with non-zero status
   - Turn timeout
   - Stalled session (no stream-JSON events)
   - Prompt render failure

4. `Tracker Failures`
   - API transport errors
   - Non-200 status
   - GraphQL errors
   - Malformed payloads

5. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink failure

### 14.2 Recovery Behavior

- Dispatch validation failures: skip new dispatches, keep service alive, continue reconciliation.
- Worker failures: convert to retries with exponential backoff.
- Tracker candidate-fetch failures: skip this tick, try again on next tick.
- Reconciliation state-refresh failures: keep current workers, retry on next tick.
- Dashboard/log failures: do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

After restart:

- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup terminal workspace cleanup
  - fresh polling of active issues
  - re-dispatching eligible work

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Editing `WORKFLOW.md` (prompt and most runtime settings) — changes re-applied automatically.
- Changing issue states in the tracker:
  - terminal state -> running session is stopped and workspace cleaned when reconciled
  - non-active state -> running session is stopped without cleanup
- Restarting the service for process recovery or deployment.

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations should state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations should state clearly what `claude.permission_mode` and tool restrictions they use.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path must remain under configured workspace root.
- Claude Code CLI `cwd` must be the per-issue workspace path for the current run.
- Workspace directory names must use sanitized identifiers.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens (`LINEAR_API_KEY`, `ANTHROPIC_API_KEY`) or secret env values.
- Validate presence of secrets without printing them.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md`.

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output should be truncated in logs.
- Hook timeouts are required to avoid hanging the orchestrator.

### 15.5 Harness Hardening Guidance

Running Claude Code agents against repositories, issue trackers, and other inputs that may contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or machine compromise if the agent is induced to execute
harmful commands.

Implementations should explicitly evaluate their own risk profile. Possible hardening measures:

- Use a restrictive `claude.permission_mode` and a narrow `allowed_tools` list.
- Use `disallowed_tools` to block dangerous capabilities like raw `Bash` when not needed.
- Add OS/container/VM sandboxing beyond the Claude Code permission system.
- Filter which Linear issues, projects, or labels are eligible for dispatch so untrusted tasks do
  not automatically reach the agent.
- Reduce filesystem paths, network destinations, and credentials available to the agent.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    claude_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    claude_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if issue.state in active_states:
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_channel) end
  )

  if worker spawn failed:
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle,
    monitor_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    claude_pid: null,
    last_message: null,
    last_event_type: null,
    last_event_timestamp: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    turn_count: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + Claude Code CLI)

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  prompt = build_prompt(workflow_template, issue, attempt)
  if prompt failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("prompt render error")

  command = build_claude_command(config.claude, prompt)
  process = spawn_process(
    command=["bash", "-lc", command],
    cwd=workspace.path,
    env={...base_env, ANTHROPIC_API_KEY: resolved_api_key}
  )

  if process failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("claude launch error")

  result = stream_process_output(
    process=process,
    timeout_ms=config.claude.turn_timeout_ms,
    on_line=(line) -> {
      event = parse_json(line)
      send(orchestrator_channel, {claude_update, issue.id, event})
    }
  )

  run_hook_best_effort("after_run", workspace.path)

  if result.exit_code != 0:
    fail_worker("claude exited with code " + result.exit_code)

  exit_normal()
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)  # bookkeeping only
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  candidates = tracker.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. Test and Validation Matrix

Validation profiles:

- `Core Conformance`: deterministic tests required for all conforming implementations.
- `Extension Conformance`: required only for optional features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence: explicit runtime path is used when provided; cwd default is
  `WORKFLOW.md`
- Workflow file changes are detected and trigger re-read/re-apply without restart
- Invalid workflow reload keeps last known good configuration and emits an operator-visible error
- Missing `WORKFLOW.md` returns typed error
- Invalid YAML front matter returns typed error
- Front matter non-map returns typed error
- Config defaults apply when optional values are missing
- `tracker.kind` validation enforces currently supported kind (`linear`)
- `tracker.api_key` works including `$VAR` indirection
- `claude.api_key` resolved from `ANTHROPIC_API_KEY` by default
- `claude.command` is preserved as a shell command string
- `claude.allowed_tools` and `claude.disallowed_tools` are correctly passed as CLI flags
- Per-state concurrency override map normalizes state names and ignores invalid values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- `after_create` hook runs only on new workspace creation
- `before_run` hook runs before each attempt; failure/timeouts abort the current attempt
- `after_run` hook runs after each attempt; failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup; failures/timeouts are ignored
- Workspace path sanitization and root containment invariants are enforced before agent launch
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths

### 17.3 Issue Tracker Client

- Candidate issue fetch uses active states and project slug
- Linear query uses the specified project filter field (`slugId`)
- Pagination preserves order across multiple pages
- Blockers are normalized from inverse relations of type `blocks`
- Labels are normalized to lowercase
- Issue state refresh by ID returns minimal normalized issues
- Error mapping for request errors, non-200, GraphQL errors, malformed payloads

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `Todo` issue with non-terminal blockers is not eligible
- `Todo` issue with terminal blockers is eligible
- Active-state issue refresh updates running entry state
- Non-active state stops running agent without workspace cleanup
- Terminal state stops running agent and cleans workspace
- Normal worker exit schedules a short continuation retry (attempt 1)
- Abnormal worker exit increments retries with 10s-based exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Stall detection kills stalled sessions and schedules retry
- Slot exhaustion requeues retries with explicit error reason

### 17.5 Claude Code CLI Client

- Launch command uses workspace cwd and invokes `bash -lc <claude.command> --print --output-format stream-json ...`
- `ANTHROPIC_API_KEY` is set in subprocess environment
- Stream-JSON events are parsed line by line from stdout
- `session_id` is extracted from `system` type events
- Token counts are extracted from `result` type events
- Turn timeout is enforced
- Partial JSON lines are buffered until newline
- Stdout and stderr are handled separately; protocol JSON is parsed from stdout only
- Non-JSON lines on stdout are logged but do not crash parsing
- `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--model` are passed when configured

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Logging sink failures do not crash orchestration
- Token/rate-limit aggregation remains correct across repeated agent updates

### 17.7 CLI and Host Lifecycle

- CLI accepts an optional positional workflow path argument (`path-to-WORKFLOW.md`)
- CLI uses `./WORKFLOW.md` when no workflow path argument is provided
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
- CLI surfaces startup failure cleanly
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally

### 17.8 Real Integration Profile (Recommended)

- A real tracker smoke test can be run with valid `LINEAR_API_KEY`.
- A real Claude Code smoke test can be run with valid `ANTHROPIC_API_KEY`.
- Real integration tests should use isolated test identifiers/workspaces.
- A skipped real-integration test should be reported as skipped, not silently treated as passed.

## 18. Implementation Checklist (Definition of Done)

### 18.1 Required for Conformance

- Workflow path selection supports explicit runtime path and cwd default
- `WORKFLOW.md` loader with YAML front matter + prompt body split
- Typed config layer with defaults and `$` resolution
- Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- Polling orchestrator with single-authority mutable state
- Issue tracker client with candidate fetch + state refresh + terminal fetch
- Workspace manager with sanitized per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
- Claude Code CLI subprocess client with stream-JSON line protocol
- Claude CLI command config (`claude.command`, default `claude`)
- `claude.max_turns` support, default `20`
- `ANTHROPIC_API_KEY` injection into subprocess environment
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Operator-visible observability (structured logs; optional snapshot/status surface)

### 18.2 Recommended Extensions (Not Required for Conformance)

- Optional HTTP server with `/api/v1/state`, `/api/v1/<issue_identifier>`, `/api/v1/refresh`
- Human-readable dashboard at `/`
- MCP-based `linear_graphql` tool injection (via Claude Code's MCP support) for in-session Linear
  access without exposing raw tokens
- Persist retry queue and session metadata across process restarts
- Configurable observability settings in workflow front matter
- Pluggable issue tracker adapters beyond Linear

### 18.3 Operational Validation Before Production (Recommended)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- Verify that `claude --print --output-format stream-json` works correctly with the installed Claude
  Code CLI version.
- If the optional HTTP server is shipped, verify the configured port behavior.
- Confirm that chosen `claude.permission_mode` and tool lists match the deployment's trust posture.
