# Spider — multi-agent coordination framework

Spider coordinates six named agent slots (Antigravity, Codex, Copilot, Kiro, Manus, and Replit) through a central dependency-aware scheduler and a four-neighbor peer topology.

## Current capabilities

- SQLite-backed agent registry, message queue, coordination plans, assignments, reports, and peer-review records.
- Dependency graph validation, bounded retries, recovery of interrupted work, and coordinator-controlled approval before dependent steps are unlocked.
- Authenticated peer messaging and review routes, with a central coordinator retaining final acceptance authority.
- A provider-neutral adapter contract and runtime lifecycle. Each provider has an isolated adapter; unavailable providers remain offline and are excluded from scheduling.
- Direct local CLI adapters for Antigravity, Codex, Copilot, and Kiro; a Manus API adapter; and a configurable authenticated bridge contract for Replit.
- A React dashboard for the agent topology and activity stream.

## Quick start

1. Use Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Install dependencies with `npm install`.
4. Configure secrets and GitHub settings as needed, then run `npm run dev`.
5. Open `http://localhost:5173`.

The API starts with provider adapters offline. See [Provider adapters and runtime lifecycle](docs/PROVIDER_ADAPTERS.md) to enable individual integrations, configure isolated workspaces, inspect `GET /api/providers`, and understand the Replit bridge contract. The current source-level execution audit and remaining blockers are documented in [Execution audit](docs/EXECUTION_AUDIT.md).

## Tests and validation

Run the automated API and provider utility tests with:

```bash
npm test
```

The API integration test uses a temporary SQLite database and keeps provider adapters disabled, so it does not require live provider credentials. Its assertions cover coordinator authorization, DAG validation/dependency gating, worker identity and credentials, token fencing, coordinator review/retry, journal and restart recovery, peer-message spoof/self-send rejection, recipient-only inbox access and acknowledgement, plus webhook fail-closed behavior without a configured secret. Provider tests cover output parsing, nested failure detection, timeout bounds, secret redaction, transient reconnect notices, and child-process environment allowlisting. The current suite has 8 Node test cases; GitHub Actions runs them and builds the dashboard on pushes and pull requests.

## Security and maturity

Provider CLI processes run on the same host/container as the Spider API, and may modify files in their configured workspace. Use a dedicated workspace per provider, keep each provider's native tool permissions restrictive, and isolate the API and worker processes at the OS/container level before multi-tenant use. The adapters do not commit, push, merge, deploy, or release work. A successful execution is submitted for review; it does not approve the result.

Secrets belong in the deployment environment or the provider's native credential store. Do not commit `.env`, place secrets in prompts, or pass broad environment allowlists to provider processes. See the provider guide for details and known boundaries. This is still an evolving framework; do not treat source changes as proof of production readiness.
