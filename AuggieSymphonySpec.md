# Auggie Symphony Service Specification

Status: Draft v1 (language-agnostic)

Purpose: Define a service that orchestrates Augment coding agents to get project work done.

This document is an adaptation of the [OpenAI Symphony Specification](https://github.com/openai/symphony/blob/main/SPEC.md) for use with Augment Code's AI coding agents instead of OpenAI Codex. The orchestration model, workspace management, and scheduling semantics are preserved from the original. The agent integration layer has been updated to leverage Augment's capabilities including MCP tools.

## 1. Problem Statement

Auggie Symphony is a long-running automation service that continuously reads work from an issue tracker
(Linear in this specification version), creates an isolated workspace for each issue, and runs an
Augment coding agent session for that issue inside the workspace.

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

- Auggie Symphony is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links) are typically performed by the Augment agent
  using tools available in the workflow/runtime environment (via Augment MCP tools or the optional
  `linear_graphql` tool extension).
- A successful run may end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker (Linear) on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support restart recovery without requiring a persistent database.
- Integrate with Augment's tool ecosystem including MCP tools.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in the
  workflow prompt and Augment agent tooling.)
- Mandating strong sandbox controls beyond what the Augment agent and host OS provide.
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

3. `Issue Tracker Client (Linear Adapter)`
   - Fetches candidate issues in active states using GraphQL.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes Linear payloads into a stable issue model.

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

6. `Agent Runner (Augment Integration)`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Launches the Augment agent subprocess or API client.
   - Streams agent updates back to the orchestrator.

7. `Status Surface` (optional)
   - Presents human-readable runtime status (terminal output, dashboard, or other operator-facing view).

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Auggie Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + Augment agent subprocess)
   - Filesystem lifecycle, workspace preparation, Augment agent protocol.

5. `Integration Layer` (Linear adapter)
   - API calls and normalization for Linear data.

6. `Observability Layer` (logs + optional status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Linear GraphQL API (issue tracker).
- GitHub API (for PR operations via Augment tools, if needed).
- Local filesystem for workspaces and logs.
- Optional workspace population tooling (for example Git CLI, if used).
- Augment Agent executable or API that supports agent mode.
- Host environment authentication for Linear and Augment.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable Linear-internal ID.
- `identifier` (string)
  - Human-readable ticket key (example: `ABC-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting (1-4, null sorts last).
- `state` (string)
  - Current Linear state name.
- `branch_name` (string or null)
  - Linear-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Derived from Linear issue relations where relation type is `blocks`.
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `estimate` (number or null)
  - Story points/estimate from Linear.
- `assignee` (string or null)
- `project` (string or null)
  - Linear project name.
- `cycle` (string or null)
  - Linear cycle name.
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
- Augment agent executable/args/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (workspace path; current runtime typically uses absolute paths)
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

State tracked while an Augment agent subprocess is running.

Fields:

- `session_id` (string)
- `augment_process_pid` (string or null)
- `last_agent_event` (string/enum or null)
- `last_agent_timestamp` (timestamp or null)
- `last_agent_message` (summarized payload)
- `input_tokens` (integer)
- `output_tokens` (integer)
- `total_tokens` (integer)
- `turn_count` (integer)
  - Number of agent turns started within the current worker lifetime.

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
- `agent_totals` (aggregate tokens + runtime seconds)
- `rate_limits` (latest rate-limit snapshot from agent events)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for Linear lookups and internal map keys.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming (e.g., `ABC-123`).
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after `trim` + `lowercase`.
- `Session ID`
  - Compose from agent `thread_id` and `turn_id` as `<thread_id>-<turn_id>`.

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
- `augment`

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
  - Supported value: `linear`
- `endpoint` (string)
  - Default for `tracker.kind == "linear"`: `https://api.linear.app/graphql`
- `api_key` (string)
  - May be a literal token or `$VAR_NAME`.
  - Canonical environment variable: `LINEAR_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
- `project_slug` (string)
  - Required for dispatch when `tracker.kind == "linear"`.
  - Maps to Linear project `slugId`.
- `active_states` (list of strings or comma-separated string)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings or comma-separated string)
  - Default: `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer or string integer)
  - Default: `30000`
  - Changes should be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/auggie_workspaces`
  - `~` and strings containing path separators are expanded.
  - Bare strings without path separators are preserved as-is.

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, optional)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, optional)
  - Runs before each agent attempt after workspace preparation.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, optional)
  - Runs after each agent attempt.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, optional)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, optional)
  - Default: `60000`
  - Applies to all workspace hooks.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer or string integer)
  - Default: `10`
  - Changes should be re-applied at runtime.
- `max_turns` (integer)
  - Default: `20`
  - Maximum number of turns per agent session.
- `max_retry_backoff_ms` (integer or string integer)
  - Default: `300000` (5 minutes)
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`trim` + `lowercase`) for lookup.

#### 5.3.6 `augment` (object)

Fields for Augment agent configuration:

- `command` (string shell command)
  - Default: `augment agent`
  - The runtime launches this command via `bash -lc` in the workspace directory.
  - The launched process must speak a compatible agent protocol over stdio.
- `model` (string)
  - Default: `claude-sonnet-4-20250514`
  - The model to use for agent sessions.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
- `read_timeout_ms` (integer)
  - Default: `5000`
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.
- `tools` (list of strings)
  - MCP tools to enable for the agent.
  - Default: `["codebase-retrieval", "view", "str-replace-editor", "save-file", "launch-process"]`
- `skills` (list of strings, optional)
  - Skills to enable for the agent.

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
  - Apply expansion only to values intended to be local filesystem paths.

### 6.2 Dynamic Reload Semantics

Dynamic reload is required:

- The software should watch `WORKFLOW.md` for changes.
- On change, it should re-read and re-apply workflow config and prompt template without restart.
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Invalid reloads should not crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

Validation checks:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- `tracker.api_key` is present after `$` resolution.
- `tracker.project_slug` is present when required by the selected tracker kind.
- `augment.command` is present and non-empty.

### 6.4 Config Fields Summary (Cheat Sheet)

- `tracker.kind`: string, required, currently `linear`
- `tracker.endpoint`: string, default `https://api.linear.app/graphql`
- `tracker.api_key`: string or `$VAR`, canonical env `LINEAR_API_KEY`
- `tracker.project_slug`: string, required (Linear project slugId)
- `tracker.active_states`: list/string, default `Todo, In Progress`
- `tracker.terminal_states`: list/string, default `Done, Closed, Cancelled, Canceled, Duplicate`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path, default `<system-temp>/auggie_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `augment.command`: shell command string, default `augment agent`
- `augment.model`: string, default `claude-sonnet-4-20250514`
- `augment.turn_timeout_ms`: integer, default `3600000`
- `augment.read_timeout_ms`: integer, default `5000`
- `augment.stall_timeout_ms`: integer, default `300000`
- `augment.tools`: list of strings, default includes core tools
- `server.port` (extension): integer, optional; enables optional HTTP server

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state.

### 7.1 Issue Orchestration States

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed.

### 7.2 Run Attempt Lifecycle

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

### 7.3 Transition Triggers

- `Poll Tick` - Reconcile, validate, fetch candidates, dispatch.
- `Worker Exit (normal)` - Schedule continuation retry.
- `Worker Exit (abnormal)` - Schedule exponential-backoff retry.
- `Agent Update Event` - Update live session fields, token counters.
- `Retry Timer Fired` - Re-fetch and attempt re-dispatch.
- `Reconciliation State Refresh` - Stop runs whose issue states are terminal.
- `Stall Timeout` - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority.
- `claimed` and `running` checks are required before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from Linear using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes (no non-terminal blockers).

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

- Global limit: `max_concurrent_agents - running_count`
- Per-state limit: `max_concurrent_agents_by_state[state]` if present

### 8.4 Retry and Backoff

- Normal continuation retries: fixed delay of `1000` ms.
- Failure-driven retries: `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`

### 8.5 Active Run Reconciliation

Part A: Stall detection

- If `elapsed_ms > augment.stall_timeout_ms`, terminate worker and queue retry.

Part B: Tracker state refresh

- Terminal state: terminate worker and clean workspace.
- Still active: update in-memory issue snapshot.
- Neither active nor terminal: terminate worker without cleanup.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts, query Linear for issues in terminal states and remove corresponding workspaces.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

- Workspace root: `workspace.root` (normalized path)
- Per-issue workspace path: `<workspace.root>/<sanitized_issue_identifier>`
- Workspaces are reused across runs for the same issue.

### 9.2 Workspace Creation and Reuse

1. Sanitize identifier to `workspace_key`.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if newly created.
5. If `created_now=true`, run `after_create` hook if configured.

### 9.3 Workspace Hooks

Supported hooks: `after_create`, `before_run`, `after_run`, `before_remove`

Execution contract:

- Execute with workspace directory as `cwd`.
- On POSIX systems, `bash -lc <script>` is the default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.

### 9.4 Safety Invariants

**Invariant 1:** Run the Augment agent only in the per-issue workspace path.

**Invariant 2:** Workspace path must stay inside workspace root.

**Invariant 3:** Workspace key is sanitized (only `[A-Za-z0-9._-]` allowed).

## 10. Agent Runner Protocol (Augment Integration)

### 10.1 Agent Execution Model

The Augment agent is launched as a subprocess with:

- `cwd` set to the per-issue workspace path.
- Environment variables for authentication and configuration.
- Communication via stdio (JSON line protocol) or Augment API.

### 10.2 Session Lifecycle

1. **Startup**: Initialize agent with workspace and configuration.
2. **Turn Loop**: Execute turns until issue reaches handoff state or max turns.
3. **Shutdown**: Clean up agent process, run `after_run` hook.

### 10.3 Multi-Turn Execution

- The first turn uses the full rendered task prompt.
- Continuation turns send only continuation guidance.
- After each turn, check if issue is still in active state.
- Continue until issue transitions or `agent.max_turns` is reached.

### 10.4 Tool Access

The Augment agent has access to configured MCP tools, typically including:

- `codebase-retrieval`: Search and understand codebase
- `view`: Read files and directories
- `str-replace-editor`: Edit existing files
- `save-file`: Create new files
- `launch-process`: Execute shell commands

### 10.5 Agent Events and Metrics

Track from agent sessions:

- Session start/end timestamps
- Turn counts
- Token usage (input/output/total)
- Last event/message
- Errors and failures

## 11. Issue Tracker Integration Contract (Linear)

### 11.1 Required Operations

An implementation must support these tracker adapter operations:

- `fetch_candidate_issues()`: Return issues in configured active states for a configured project.
- `fetch_issues_by_states(state_names)`: Used for startup terminal cleanup.
- `fetch_issue_states_by_ids(issue_ids)`: Used for active-run reconciliation.

### 11.2 Query Semantics (Linear)

For `tracker.kind == "linear"`:

- GraphQL endpoint (default `https://api.linear.app/graphql`)
- Auth token sent in `Authorization` header
- `tracker.project_slug` maps to Linear project `slugId`
- Candidate issue query filters project using `project: { slugId: { eq: $projectSlug } }`
- Issue-state refresh query uses GraphQL issue IDs with variable type `[ID!]`
- Pagination required for candidate issues
- Page size default: 50
- Network timeout: 30000 ms

Important:

- Linear GraphQL schema details can drift. Keep query construction isolated and test the exact query
  fields/types required by this specification.

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

Auggie Symphony does not require first-class tracker write APIs in the orchestrator.

- Ticket mutations (state transitions, comments, PR metadata) are typically handled by the Augment
  agent using tools defined by the workflow prompt.
- The service remains a scheduler/runner and tracker reader.
- Workflow-specific success often means "reached the next handoff state" (for example
  `Human Review`) rather than tracker terminal state `Done`.
- If the optional `linear_graphql` client-side tool extension is implemented, it is still part of
  the agent toolchain rather than orchestrator business logic.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

- `workflow.prompt_template`
- normalized `issue` object
- optional `attempt` integer

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` should be passed to the template for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 12.4 Failure Semantics

If prompt rendering fails, fail the run attempt immediately.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

Required context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

Required context for agent session lifecycle logs:

- `session_id`

### 13.2 Runtime Snapshot / Monitoring Interface (Optional)

If implemented, should return:

- `running` (list of running session rows with `turn_count`)
- `retrying` (list of retry queue rows)
- `agent_totals` (input_tokens, output_tokens, total_tokens, seconds_running)
- `rate_limits` (if available)

### 13.3 Optional HTTP Server Extension

If implemented:

- `GET /api/v1/state`: Current system state summary
- `GET /api/v1/<issue_identifier>`: Issue-specific details
- `POST /api/v1/refresh`: Trigger immediate poll cycle

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. **Workflow/Config Failures**: Missing `WORKFLOW.md`, invalid YAML, missing credentials
2. **Workspace Failures**: Directory creation failure, hook failures
3. **Agent Session Failures**: Startup failure, turn timeout, stall
4. **Tracker Failures**: API errors, malformed payloads
5. **Observability Failures**: Log sink failures

### 14.2 Recovery Behavior

- Dispatch validation failures: skip dispatches, keep service alive.
- Worker failures: convert to retries with exponential backoff.
- Tracker failures: skip tick, try again next tick.
- Dashboard/log failures: do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

After restart:

- No retry timers are restored.
- Service recovers by startup terminal cleanup, fresh polling, and re-dispatching.

## 15. Security and Operational Safety

### 15.1 Filesystem Safety Requirements

Mandatory:

- Workspace path must remain under configured workspace root.
- Agent cwd must be the per-issue workspace path.
- Workspace directory names must use sanitized identifiers.

### 15.2 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.

### 15.3 Hook Script Safety

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook timeouts are required to avoid hanging the orchestrator.

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
    agent_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    rate_limits: null
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

### 16.3 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    last_agent_message: null,
    last_agent_event: null,
    last_agent_timestamp: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.4 Worker Attempt

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  session = augment_agent.start_session(workspace=workspace.path)
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(workflow_template, issue, attempt, turn_number, max_turns)
    if prompt failed:
      augment_agent.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = augment_agent.run_turn(
      session=session,
      prompt=prompt,
      issue=issue,
      on_message=(msg) -> send(orchestrator_channel, {agent_update, issue.id, msg})
    )

    if turn_result failed:
      augment_agent.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed_issue = tracker.fetch_issues_by_ids([issue.id])
    if refreshed_issue failed:
      augment_agent.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    issue = refreshed_issue[0] or issue

    if issue.state is not active:
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  augment_agent.stop_session(session)
  run_hook_best_effort("after_run", workspace.path)

  exit_normal()
```

## 17. Test and Validation Matrix

### 17.1 Workflow and Config Parsing

- Workflow file path precedence works correctly
- Workflow file changes trigger re-read/re-apply without restart
- Invalid workflow reload keeps last known good configuration
- Missing `WORKFLOW.md` returns typed error
- Config defaults apply when optional values are missing
- `tracker.kind` validation enforces supported kind (`linear`)
- `$VAR` resolution works for tracker credentials and path values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- `after_create` hook runs only on new workspace creation
- `before_run` hook failure aborts the current attempt
- Workspace path sanitization enforced before agent launch
- Agent launch uses per-issue workspace path as cwd

### 17.3 Issue Tracker Client (Linear)

- Candidate issue fetch uses active states and project slug
- Linear query uses the specified project filter field (`slugId`)
- Empty `fetch_issues_by_states([])` returns empty without API call
- Pagination preserves order across multiple pages
- Blockers are normalized from inverse relations of type `blocks`
- Labels are normalized to lowercase
- Issue state refresh by ID returns minimal normalized issues
- Issue state refresh query uses GraphQL ID typing (`[ID!]`) as specified in Section 11.2
- Error mapping for request errors, non-200, GraphQL errors, malformed payloads

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `To Do` issue with non-terminal blockers is not eligible
- Active-state issue refresh updates running entry state
- Terminal state stops running agent and cleans workspace
- Normal worker exit schedules continuation retry (attempt 1)
- Abnormal worker exit increments retries with exponential backoff
- Stall detection kills stalled sessions and schedules retry

### 17.5 Augment Agent Client

- Launch command uses workspace cwd
- Turn timeout is enforced
- Token usage is tracked correctly
- Agent events are forwarded to orchestrator

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Token aggregation remains correct across repeated agent updates

### 17.7 CLI and Host Lifecycle

- CLI accepts optional positional workflow path argument
- CLI uses `./WORKFLOW.md` when no argument provided
- CLI errors on nonexistent workflow path
- CLI exits with success when application starts and shuts down normally

## 18. Implementation Checklist (Definition of Done)

### 18.1 Required for Conformance

- [ ] Workflow path selection supports explicit runtime path and cwd default
- [ ] `WORKFLOW.md` loader with YAML front matter + prompt body split
- [ ] Typed config layer with defaults and `$` resolution
- [ ] Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- [ ] Polling orchestrator with single-authority mutable state
- [ ] Linear tracker client with candidate fetch + state refresh + terminal fetch
- [ ] Workspace manager with sanitized per-issue workspaces
- [ ] Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- [ ] Hook timeout config (`hooks.timeout_ms`, default `60000`)
- [ ] Augment agent subprocess client
- [ ] Strict prompt rendering with `issue` and `attempt` variables
- [ ] Exponential retry queue with continuation retries after normal exit
- [ ] Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- [ ] Reconciliation that stops runs on terminal/non-active tracker states
- [ ] Workspace cleanup for terminal issues
- [ ] Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- [ ] Operator-visible observability

### 18.2 Recommended Extensions

- [ ] Optional HTTP server with dashboard and REST API (see Section 13.3)
- [ ] Optional `linear_graphql` client-side tool extension for agent-driven tracker mutations
- [ ] Persist retry queue and session metadata across process restarts
- [ ] Pluggable issue tracker adapters beyond Linear
- [ ] GitHub integration for PR operations

### 18.3 Operational Validation Before Production

- [ ] Run integration tests with valid Linear credentials (`LINEAR_API_KEY`)
- [ ] Verify hook execution on target host OS/shell environment
- [ ] If HTTP server is shipped, verify port behavior and loopback bind

---

## Appendix A: Example WORKFLOW.md

```yaml
---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Duplicate

polling:
  interval_ms: 30000

workspace:
  root: ~/auggie_workspaces

hooks:
  after_create: |
    git clone git@github.com:myorg/myrepo.git .
    npm install
  before_run: |
    git fetch origin
    git checkout main
    git pull
  after_run: |
    git status

agent:
  max_concurrent_agents: 5
  max_turns: 20

augment:
  model: claude-sonnet-4-20250514
  tools:
    - codebase-retrieval
    - view
    - str-replace-editor
    - save-file
    - launch-process
---

# Issue Resolution Workflow

You are an Augment coding agent working on Linear issue **{{ issue.identifier }}**.

## Task Details

- **Title**: {{ issue.title }}
- **Priority**: {{ issue.priority }}
- **Labels**: {{ issue.labels | join: ", " }}
- **Project**: {{ issue.project }}

## Description

{{ issue.description }}

## Instructions

1. Read and understand the issue requirements.
2. Use `codebase-retrieval` to find relevant code.
3. Implement the necessary changes using `str-replace-editor` or `save-file`.
4. Run tests to verify your changes work correctly.
5. Create a pull request and link it to this issue.
6. Update the issue state to indicate progress.

{% if attempt %}
**Note**: This is retry attempt {{ attempt }}. Review previous errors and adjust approach.
{% endif %}
```

---

## Appendix B: Comparison with OpenAI Symphony

| Feature | OpenAI Symphony | Auggie Symphony |
|---------|-----------------|-----------------|
| Issue Tracker | Linear (GraphQL) | Linear (GraphQL) |
| Agent | Codex app-server | Augment Agent |
| Agent Protocol | JSON-RPC over stdio | Augment protocol |
| Tracker Writes | Optional linear_graphql tool | Optional linear_graphql tool |
| Default Active States | Todo, In Progress | Todo, In Progress |
| PR Integration | Via agent tools | Via Augment tools |
| Config Key | `codex` | `augment` |

Both implementations share:
- Linear GraphQL API for issue tracking
- Polling-based orchestration
- Per-issue workspace isolation
- WORKFLOW.md configuration
- Exponential retry backoff
- Hook-based workspace lifecycle
- Terminal state cleanup
- Optional HTTP server extension

