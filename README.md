# Symphony

Symphony is a long-running automation service that orchestrates AI coding agents to work on project issues. It continuously reads work from an issue tracker (Linear), creates isolated workspaces for each issue, and runs coding agent sessions to complete the work.

This repository contains specification documents adapting the [OpenAI Symphony Specification](https://github.com/openai/symphony/blob/main/SPEC.md) for different AI coding agents:

- **[AuggieSymphonySpec.md](AuggieSymphonySpec.md)** - Specification for Augment Code agents
- **[ClaudeCodeSymphonySpec.md](ClaudeCodeSymphonySpec.md)** - Specification for Claude Code CLI agents

## Key Features

- Repeatable daemon workflow for issue execution
- Per-issue workspace isolation
- In-repo workflow policy via `WORKFLOW.md`
- Observability for concurrent agent runs
- Restart recovery without persistent database

## How It Works

1. Symphony polls the issue tracker on a fixed cadence
2. Eligible issues are dispatched to coding agents with bounded concurrency
3. Each issue gets an isolated workspace
4. Agents follow the repository's `WORKFLOW.md` contract
5. Completed work is handed off (e.g., PR created, status updated)

## License

See the original [OpenAI Symphony](https://github.com/openai/symphony) for licensing information.

