# Spider provider adapters and runtime lifecycle

## Design

Spider's coordinator talks to a provider-neutral runtime contract, not vendor-specific commands directly. Each adapter implements:

- `health()`: returns readiness, a safe reason, timestamp, and auth-probe state.
- `runTask(work)`: executes one assigned work item and returns a bounded summary, evidence references, and success indication.
- `maxConcurrentTasks`: limits simultaneous calls to a provider runtime.

The shared runtime manager refreshes health on a configurable interval, checks readiness again before dispatch, bounds in-flight calls, redacts common credential formats from output, and reports state changes to the coordinator. Configured identities are reserved in the six canonical Spider slots. All adapters are offline by default. A slot's existence is not evidence that the vendor CLI, credentials, workspace, or remote integration is usable.

## Provider-specific adapter map

| Spider slot | Adapter | Execution path | Required setup |
|---|---|---|---|
| Antigravity | `providers/antigravity.js` | `agy -p ... --output-format json --sandbox` | Install and authenticate Antigravity CLI; enable adapter and set a dedicated workspace |
| Codex | `providers/codex.js` | `codex exec --sandbox workspace-write --json ...` | Install and authenticate Codex CLI; enable adapter and set a dedicated workspace |
| Copilot | `providers/copilot.js` | `copilot -p ... --output-format json --no-ask-user` | Install and authenticate GitHub Copilot CLI; enable adapter and set a dedicated workspace |
| Kiro | `providers/kiro.js` | `kiro-cli chat --no-interactive ...` | Install and authenticate Kiro CLI; enable adapter and set a dedicated workspace |
| Manus | `providers/manus.js` | Manus API v2 task creation and task-message polling | Enable adapter and set `MANUS_API_KEY` |
| Replit | `providers/replit.js` | Authenticated HTTP bridge | Deploy/authorize a bridge and configure its URL and server-side token |

Antigravity documents a headless `-p` mode and JSON output; Codex, Copilot CLI, and Kiro expose non-interactive execution paths in their CLI documentation; Manus provides a task creation and polling API. Replit's adapter intentionally uses a bridge contract rather than claiming a general-purpose public Agent execution API is available.

## Configuration

Copy `.env.example` to the API's environment and enable only adapters you have configured. For example:

```dotenv
SPIDER_CODEX_ENABLED=true
SPIDER_CODEX_COMMAND=codex
SPIDER_CODEX_WORKSPACE=/absolute/path/to/spider-codex-worktree
SPIDER_CODEX_SANDBOX=workspace-write
SPIDER_CODEX_TIMEOUT_MS=300000
SPIDER_PROVIDER_POLL_INTERVAL_MS=30000
```

The local CLI adapters use a cross-platform subprocess launcher (including Windows CLI shims) and require a dedicated, existing directory for each provider. Spider will not automatically clone a repo, create worktrees, authenticate a CLI, grant provider permissions, or turn on a provider. Keep each workspace isolated from other active agents. The configured workspace is the subprocess working directory; enforcement against access to other filesystem paths still depends on the host/container and that provider's own tool permissions.

CLI processes receive a conservative environment allowlist by default (PATH, user home and essential OS variables). They do not inherit all API environment variables. If a provider genuinely needs an environment-based credential, explicitly allow only the required variable names with the adapter's `SPIDER_<PROVIDER>_PASSTHROUGH_ENV` setting, for example `SPIDER_CODEX_PASSTHROUGH_ENV=OPENAI_API_KEY`. The variable's value stays out of Spider's HTTP responses, but any tool the provider executes may be able to read variables passed to its process. Prefer CLI-native login/keychain support where possible.

Codex sandbox configuration accepts `read-only` or `workspace-write`; the adapter falls back to `read-only` when the value is omitted or invalid. The provided `.env.example` explicitly selects `workspace-write` for implementation tasks inside the configured workspace. It never adds a dangerous full-filesystem mode. Antigravity uses its sandbox flag. Copilot does not use a blanket allow-all-tools switch, and Kiro does not use `--trust-all-tools`. Keep each provider's native permission policy restrictive and human-reviewed. Provider adapters do not commit, push, merge, deploy, or release work.

Manus tasks are private, polled until stopped/waiting/error or timeout, and return task ID/URL references when available. A waiting or error result is submitted as an incomplete report for coordinator review rather than treated as a completed step.

### Replit bridge contract

Configure `SPIDER_REPLIT_BRIDGE_URL` as the bridge base URL and set the required `SPIDER_REPLIT_BRIDGE_TOKEN`. The base URL must be HTTPS except that HTTP is accepted for localhost. The bridge must implement:

- `GET /health` returning JSON with `ok: true` or `ready: true`.
- `POST /execute` receiving `{ task: { id, planId, key, title, description, objective, attempt, maxAttempts, dependsOn }, prompt }`.
- The execution response must include a non-empty `summary` or `output`. It may include `success: false` and an `evidence: string[]`.

Every request includes `Authorization: Bearer <token>`; Spider keeps the bridge offline when the token is missing. The bridge should validate the token, provision an isolated workspace per task, enforce timeouts, and never expose credentials in the response. Spider does not deploy the bridge or infer Replit project IDs.

## Runtime lifecycle

1. Startup creates or restores the six reserved provider identities in their canonical slots, all marked offline until their adapter health checks pass.
2. `GET /api/providers` lists status, safe failure reason, last probe time, current task count, and capacity. `GET /api/health` includes the same provider state summary.
3. An enabled, ready adapter marks its corresponding agent available. Disabled or unready adapters remain offline and are excluded from scheduling.
4. The coordinator assigns a durable step, places it in the agent's active task list, and dispatches it to the adapter. Execution begins the step and runs with a bounded timeout.
5. A provider result is stored as a durable report and moved to `review`. Even successful CLI exit does not approve the work or unlock dependencies. Peer feedback remains advisory and coordinator approval is required.
6. If an invocation cannot start or times out, the agent work lease is released and the step is returned to `ready` while attempts remain, or marked `failed` when exhausted. The adapter is marked offline until a later health probe makes it available again.
7. Local CLI adapters are fixed to one concurrent task because each is bound to one writable workspace. Manus and the Replit bridge support bounded remote concurrency (1–3); for Replit, the bridge must provision isolated task workspaces before enabling concurrency above one.

## Operations and security boundaries

- Provider CLI execution occurs on the same host/container as the Spider API. Do not enable local adapters on a multi-tenant API host unless the provider processes are isolated at the OS/container level.
- Do not put credentials in prompts, work descriptions, evidence references, logs, or dashboard code.
- `SPIDER_COORDINATOR_API_KEY` remains separate from provider credentials and is required for plan-management/review endpoints.
- Peer messaging and coordinator actions stay disabled when their API key is absent, shorter than 32 characters, or a recognized placeholder. Do not deploy with example credentials. GitHub webhooks are rejected until a non-placeholder `GITHUB_WEBHOOK_SECRET` of at least 32 characters is configured.
- The adapter status `authState: not-probed` means configuration and executable/workspace were found, not that a full authenticated model request has been verified. The first real call is the functional authentication check.
- The Replit bridge is a separate service that must be built, hosted, and secured for your deployment. Without a valid bridge, the Replit slot remains offline.
- No tests or builds were run as part of this change, in keeping with the instruction to skip testing for now.

## Official command/API references

- Antigravity headless mode: https://www.antigravity.google/docs/cli/headless/
- Codex CLI docs: https://developers.openai.com/codex/cli/
- GitHub Copilot CLI programmatic reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- Kiro CLI command reference: https://kiro.dev/docs/cli/reference/cli-commands/
- Manus API task creation: https://open.manus.ai/docs/v2/task.create
- Manus task lifecycle: https://open.manus.ai/docs/v2/task-lifecycle
