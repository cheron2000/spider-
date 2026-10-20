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
4. The coordinator assigns a durable step, creates a unique assignment token, persists assignment/expiry/activity timestamps, places the step in the agent's active task list, and dispatches it to the adapter.
5. While a provider call is active, Spider renews the lease. Results are accepted only if the assignment token remains current and unexpired; the report and transition to `review` are stored atomically. Even successful CLI exit does not approve the work or unlock dependencies. Peer feedback remains advisory and coordinator approval is required.
6. If an invocation cannot start or times out, the agent work lease is released and the step is returned to `ready` while attempts remain, or marked `failed` when exhausted. The adapter is marked offline until a later health probe makes it available again.
7. Local CLI adapters are fixed to one concurrent task because each is bound to one writable workspace. Manus and the Replit bridge support bounded remote concurrency (1–3); for Replit, the bridge must provision isolated task workspaces before enabling concurrency above one.

## Operations and security boundaries

- Provider CLI execution occurs on the same host/container as the Spider API. Do not enable local adapters on a multi-tenant API host unless the provider processes are isolated at the OS/container level.
- Do not put credentials in prompts, work descriptions, evidence references, logs, or dashboard code.
- `SPIDER_COORDINATOR_API_KEY` remains separate from provider credentials and is required for plan-management/review endpoints.
- Coordinator actions stay disabled when `SPIDER_COORDINATOR_API_KEY` is absent, shorter than 32 characters, or a recognized placeholder. External worker routes require a provisioned per-agent credential. Do not deploy with example credentials. GitHub webhooks are rejected until a non-placeholder `GITHUB_WEBHOOK_SECRET` of at least 32 characters is configured.
- The adapter status `authState: not-probed` means configuration and executable/workspace were found, not that a full authenticated model request has been verified. The first real call is the functional authentication check.
- The Replit bridge is a separate service that must be built, hosted, and secured for your deployment. Without a valid bridge, the Replit slot remains offline.
- Lease fencing protects Spider's SQLite coordination state; it does not undo external side effects from a worker whose lease expired. Work that is not safe to repeat needs task-specific idempotency or compensation.
- No tests or builds were run as part of this change, in keeping with the instruction to skip testing for now.

## Official command/API references

- Antigravity headless mode: https://www.antigravity.google/docs/cli/headless/
- Codex CLI docs: https://developers.openai.com/codex/cli/
- GitHub Copilot CLI programmatic reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- Kiro CLI command reference: https://kiro.dev/docs/cli/reference/cli-commands/
- Manus API task creation: https://open.manus.ai/docs/v2/task.create
- Manus task lifecycle: https://open.manus.ai/docs/v2/task-lifecycle


## Authenticated external-worker endpoints

Mutating external-worker endpoints use an identity-bound credential:
`x-agent-id: <registered-agent-id>` and `x-spider-agent-key: <per-agent credential>`.
The coordinator provisions credentials through `POST /api/agents/register`; the response includes a randomly generated credential shown once when the identity has no credential yet. For an existing agent, rotate it with `POST /api/agents/:id/credential`. Store the value in the worker's secret manager. SQLite stores only the SHA-256 hash, and read APIs never return the credential. Rotation immediately invalidates the previous credential. Worker registration, credential rotation, and removal require `x-spider-coordinator-key: <SPIDER_COORDINATOR_API_KEY>`; only an administrator/coordinator should provision identities.

- `POST /api/agents/register`: coordinator-authenticated provisioning; returns a new per-agent credential once if none exists.
- `POST /api/agents/:id/credential`: coordinator-authenticated credential rotation; returns the replacement once and immediately invalidates the previous credential.
- `DELETE /api/agents/:id`: coordinator-authenticated removal.
- `POST /api/agents/:id/heartbeat`: agent-authenticated; the path identity must equal `x-agent-id`.
- `POST /api/tasks/:id/claim`, `/progress`, and `/complete`: agent-authenticated; an agent may only mutate its own claimed task. Provider-backed identities must use the coordinator's dependency-aware execution path.
- `GET /api/agents/:id/work` returns active step lease expiry and assignment token. Workers must retain the token with that attempt.
- `POST /api/coordinator/steps/:id/start` and `/submit` require the current `assignmentToken` supplied by the work queue.
- `POST /api/coordinator/steps/:id/heartbeat` renews the lease for the current token; expired/revoked assignments are rejected.
- `GET /api/agents/:id/reviews` and peer messaging retain agent authentication.
- Lease duration is controlled by `SPIDER_ASSIGNMENT_LEASE_MS` (default 120000 ms, clamped to 30000–3600000 ms).

The dashboard's current “New objective” action uses the GitHub issue starter-plan endpoint (`POST /api/ceo/plan`). The durable provider-coordinator DAG API is separate and requires the coordinator key; the dashboard does not yet expose that full workflow. Do not interpret issue creation as automatic provider execution.

## Source-level execution audit (2026-10-20)

This audit reviewed the planning, scheduling, provider dispatch, report submission, and external-worker mutation paths in source. It did not run builds or tests.

Issues addressed in the audit commit:
- Require coordinator authentication to provision or remove external workers.
- Require agent authentication and identity matching for heartbeat, claim, progress, and completion; reject duplicate/non-owned task mutation and provider-backed manual claims.
- Re-run scheduling when a worker registers or heartbeats back online, so ready coordination steps do not wait unnecessarily for a manual advance.
- Require a Replit bridge health response to explicitly report `ok: true` or `ready: true`, and recognize more common CLI HTTP authentication failures.
- Parse Manus v2's documented `assistant_message.content` output shape and verify task detail and require an explicit no-background-jobs state before treating stopped tasks as successful.

Known blockers after source review:
- Dashboard objective creation and the durable provider DAG are still separate workflows.
- CORS is not an access-control boundary. Keep the API on a trusted local network or place it behind an authenticated gateway before exposing it to untrusted networks.
- Lease expiry requeues or fails stale assignments and token-fences submissions. It does not undo external side effects; non-idempotent work still needs task-specific recovery or compensation.
- Provider CLI flag/output compatibility and remote provider credentials have not been validated end-to-end. The Manus adapter now checks task detail after a stopped event, but live API execution remains unverified. Replit still requires a separately deployed bridge.
- GitHub issue task status/progress/completion is held in process memory and is reconstructed from GitHub issue metadata on sync; these runtime updates are not a durable task journal.


## Dashboard and read API access control

Task, agent, event, provider, and topology read endpoints now require `x-spider-coordinator-key`. The dashboard stores the coordinator key in browser local storage and sends it in API requests and the Socket.IO handshake. The API sends framework snapshots and live framework events only to authenticated coordinator sockets. The public health endpoint remains intentionally limited to operational status and must not be treated as an authenticated diagnostic endpoint. Do not use the dashboard on a shared/untrusted browser profile, and do not expose the API directly to the public internet.
