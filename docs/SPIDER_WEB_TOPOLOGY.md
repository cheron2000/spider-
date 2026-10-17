# Spider-web agent collaboration topology

## Goal

Spider uses a hybrid supervisor + peer collaboration graph. The CEO/coordinator owns task decomposition, budgets, dependency state, and final acceptance. Each of the six planned provider adapters—Antigravity, Codex, Copilot, Kiro, Manus, and Replit—has four lateral peer links: two neighbors on either side of a six-node ring.

## Peer topology

For agents ordered A, B, C, D, E, F around the ring:

- A peers with B, C, E, F.
- B peers with A, C, D, F.
- C peers with A, B, D, E.
- D peers with B, C, E, F.
- E peers with A, C, D, F.
- F peers with A, B, D, E.

Each agent can request review, ask for a missing artifact, challenge an assumption, or send a typed handoff to any of its four peers. Peer links are logical routing permissions; they do not mean all six vendors are already connected or running.

## Message contract

Every peer message should include:
- `taskId`, `traceId`, `fromAgent`, `toAgent`
- `kind`: `request_review`, `question`, `artifact_ready`, `blocker`, or `handoff`
- `summary`, `artifactRefs`, `createdAt`
- optional `replyTo` and `deadlineAt`

Use references to artifacts/branches rather than copying full transcripts. Store messages as append-only events so the work is auditable.

## Execution rules

1. The CEO decomposes objectives and assigns one owner to each task.
2. Independent tasks may run in parallel, each in an isolated branch/worktree.
3. Peer agents collaborate through scoped messages and artifacts; they must not overwrite each other's workspace.
4. A reviewer should be independent of the author where practical.
5. The coordinator reconciles conflicting recommendations and owns final acceptance.
6. Bound message fan-out, retries, wall-clock time, and model/API spend. Detect cycles and stop repeated agent debates.
7. Keep human approval before merging or executing risky commands.

## Implementation status

The dashboard spider-web graphic is a topology blueprint. Provider authentication, real adapter launches, durable peer messaging, and live collaboration are not implemented merely by drawing the graph. Add and test each provider adapter against supported interfaces before marking it connected.
