# Universal Agent Framework

A GitHub-first starter for coordinating software agents through issues, a task graph dashboard, and local/remote worker protocols.

## Status
This repository is the framework template, not an individual project created from it. GitHub Issues are intended to be the durable task source of truth. The initial scaffold provides a Node.js API, React task-network UI, issue synchronization, a deterministic CEO planning endpoint, and worker registration/progress endpoints.

## Quick start
1. Use Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set `GITHUB_TOKEN` and `GITHUB_REPOSITORY=owner/repo`.
4. Run `npm install`, then `npm run dev`.
5. Open `http://localhost:5173` and use **Demo graph** or **Sync GitHub**.

## Safety / maturity
This is an MVP scaffold. The planner is deterministic, not an LLM planner; task/agent telemetry is in memory; remote execution is a protocol only, not a sandbox. Before production use, add authentication, durable storage/leases, rate limits, audit logs, approval gates, and isolated worker execution. Never commit `.env` or credentials.

## GitHub template
After the initial implementation is reviewed, enable **Settings → General → Template repository**. Each project created from the template should have its own issues, credentials, branches, and configuration.