import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const COORDINATOR_KEY = 'test-coordinator-key-that-is-long-enough-123456789';
const WORKER_ID = 'integration-worker';

let apiProcess;
let baseUrl;
let output = '';
let tempDirectory;
let databasePath;
let testDb;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function apiEnvironment(port) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    SPIDER_DB_PATH: databasePath,
    SPIDER_COORDINATOR_API_KEY: COORDINATOR_KEY,
    SPIDER_ASSIGNMENT_LEASE_MS: '30000',
    SPIDER_PROVIDER_POLL_INTERVAL_MS: '120000',
    GITHUB_TOKEN: '',
    GITHUB_REPOSITORY: '',
    GITHUB_WEBHOOK_SECRET: '',
    SPIDER_ANTIGRAVITY_ENABLED: 'false',
    SPIDER_CODEX_ENABLED: 'false',
    SPIDER_COPILOT_ENABLED: 'false',
    SPIDER_KIRO_ENABLED: 'false',
    SPIDER_MANUS_ENABLED: 'false',
    SPIDER_REPLIT_ENABLED: 'false',
    MANUS_API_KEY: '',
    SPIDER_REPLIT_BRIDGE_URL: '',
    SPIDER_REPLIT_BRIDGE_TOKEN: '',
  };
  delete env.DOTENV_CONFIG_PATH;
  return env;
}

async function startApi() {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  output = '';
  apiProcess = spawn(process.execPath, ['services/api/src/index.js'], {
    cwd: REPO_ROOT,
    env: apiEnvironment(port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProcess.stdout.setEncoding('utf8');
  apiProcess.stderr.setEncoding('utf8');
  apiProcess.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
  apiProcess.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) {
      throw new Error(`Spider API exited before becoming healthy. Output:\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Spider API did not become healthy. Output:\n${output}`);
}

async function stopApi() {
  if (!apiProcess || apiProcess.exitCode !== null) return;
  const child = apiProcess;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    sleep(3000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
  apiProcess = undefined;
}

async function request(route, { method = 'GET', key = true, agentId, agentKey, body } = {}) {
  const headers = {};
  if (key) headers['x-spider-coordinator-key'] = COORDINATOR_KEY;
  if (agentId) headers['x-agent-id'] = agentId;
  if (agentKey) headers['x-spider-agent-key'] = agentKey;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(baseUrl + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function responseJson(response) {
  return response.json();
}

test('coordinator DAG enforces authorization, dependency gates, token fencing, retry and restart recovery', { timeout: 60000 }, async t => {
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'spider-api-test-'));
  databasePath = path.join(tempDirectory, 'spider-test.db');
  t.after(async () => {
    await stopApi();
    testDb?.close();
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });
  await startApi();
  testDb = new Database(databasePath);

  // Coordinator-only reads and mutations must reject missing coordinator credentials.
  assert.equal((await request('/api/coordinator/plans', { key: false })).status, 401);
  assert.equal((await request('/api/tasks', { key: false })).status, 401);

  // A malformed dependency graph must be rejected before it is persisted.
  const cyclic = await request('/api/coordinator/plans', {
    method: 'POST',
    body: {
      objective: 'Reject cyclic dependency graph',
      steps: [
        { key: 'alpha', title: 'Alpha', description: 'A', dependsOn: ['beta'] },
        { key: 'beta', title: 'Beta', description: 'B', dependsOn: ['alpha'] },
      ],
    },
  });
  assert.equal(cyclic.status, 400);
  assert.match((await responseJson(cyclic)).error, /cycle/i);

  // Register a real API worker and capture the one-time credential.
  const registration = await request('/api/agents/register', {
    method: 'POST',
    body: {
      id: WORKER_ID,
      name: 'Integration Test Worker',
      runtime: 'local',
      capabilities: ['testing', 'review'],
      maxConcurrentTasks: 1,
    },
  });
  assert.equal(registration.status, 201);
  const registered = await responseJson(registration);
  assert.ok(registered.credential?.value, 'registration should issue the credential once');
  const workerKey = registered.credential.value;

  // Exercise peer-message authorization and durable inbox delivery with a full peer ring.
  const workerCredentials = new Map([[WORKER_ID, workerKey]]);
  for (let index = 2; index <= 5; index++) {
    const id = `integration-worker-${index}`;
    const response = await request('/api/agents/register', {
      method: 'POST',
      body: { id, name: `Integration Worker ${index}`, runtime: 'local', capabilities: ['testing'], maxConcurrentTasks: 1 },
    });
    assert.equal(response.status, 201);
    workerCredentials.set(id, (await responseJson(response)).credential.value);
  }
  const topology = await responseJson(await request('/api/topology'));
  const peerId = topology.peerMap[WORKER_ID]?.[0];
  assert.ok(peerId, 'registered workers should have at least one lateral peer');
  const messagePayload = {
    taskId: 'general', traceId: 'phase-b-peer-trace', fromAgent: WORKER_ID,
    toAgent: peerId, kind: 'question', summary: 'Confirm peer message delivery.', artifactRefs: [],
  };
  assert.equal((await request('/api/messages', {
    method: 'POST', agentId: WORKER_ID, agentKey: workerKey,
    body: { ...messagePayload, fromAgent: peerId },
  })).status, 403, 'sender identity must match authenticated worker');
  assert.equal((await request('/api/messages', {
    method: 'POST', agentId: WORKER_ID, agentKey: workerKey,
    body: { ...messagePayload, toAgent: WORKER_ID },
  })).status, 400, 'self-messaging must be rejected');
  const messageResponse = await request('/api/messages', {
    method: 'POST', agentId: WORKER_ID, agentKey: workerKey, body: messagePayload,
  });
  assert.equal(messageResponse.status, 201);
  const message = (await responseJson(messageResponse)).message;
  assert.equal(message.status, 'queued');
  assert.equal((await request(`/api/agents/${peerId}/messages`, {
    agentId: WORKER_ID, agentKey: workerKey,
  })).status, 403, 'workers may only read their own inbox');
  const inboxResponse = await request(`/api/agents/${peerId}/messages`, {
    agentId: peerId, agentKey: workerCredentials.get(peerId),
  });
  assert.equal(inboxResponse.status, 200);
  const inbox = (await responseJson(inboxResponse)).messages;
  assert.ok(inbox.some(item => item.id === message.id && item.status === 'delivered'));
  assert.equal((await request(`/api/messages/${message.id}/ack`, {
    method: 'POST', agentId: WORKER_ID, agentKey: workerKey, body: {},
  })).status, 403, 'only the recipient may acknowledge a message');
  const ackResponse = await request(`/api/messages/${message.id}/ack`, {
    method: 'POST', agentId: peerId, agentKey: workerCredentials.get(peerId), body: {},
  });
  assert.equal(ackResponse.status, 200);
  assert.equal((await responseJson(ackResponse)).message.status, 'acknowledged');
  assert.equal((await request('/api/webhooks/github', {
    method: 'POST', body: { action: 'opened' },
  })).status, 503, 'webhook endpoint must stay disabled when no secret is configured');

  // Create a two-step DAG. Only the root should become assigned; child stays blocked.
  const createdResponse = await request('/api/coordinator/plans', {
    method: 'POST',
    body: {
      objective: 'Verify coordinator execution invariants',
      steps: [
        { key: 'root', title: 'Root step', description: 'First step', dependsOn: [], maxAttempts: 2 },
        { key: 'child', title: 'Dependent step', description: 'Second step', dependsOn: ['root'], maxAttempts: 1 },
      ],
    },
  });
  assert.equal(createdResponse.status, 201);
  const created = await responseJson(createdResponse);
  const planId = created.plan.id;
  let plan = (await responseJson(await request(`/api/coordinator/plans/${planId}`))).plan;
  let root = plan.steps.find(step => step.key === 'root');
  let child = plan.steps.find(step => step.key === 'child');
  assert.equal(root.status, 'assigned');
  assert.equal(child.status, 'blocked');
  assert.equal(Object.hasOwn(root, 'assignmentToken'), false, 'coordinator plan response must not leak lease token');

  // Only the registered worker with its identity-bound credential may fetch work.
  assert.equal((await request(`/api/agents/${WORKER_ID}/work`, { agentId: WORKER_ID, agentKey: 'wrong-key' })).status, 401);
  assert.equal((await request(`/api/agents/not-the-worker/work`, { agentId: WORKER_ID, agentKey: workerKey })).status, 403);
  const workResponse = await request(`/api/agents/${WORKER_ID}/work`, { agentId: WORKER_ID, agentKey: workerKey });
  assert.equal(workResponse.status, 200);
  const rootWork = (await responseJson(workResponse)).work.find(step => step.key === 'root');
  assert.ok(rootWork?.assignmentToken, 'worker queue must carry the current assignment token');

  // A stale token must not start or submit a step.
  const staleToken = 'x'.repeat(43);
  assert.equal((await request(`/api/coordinator/steps/${root.id}/start`, {
    method: 'POST', agentId: WORKER_ID, agentKey: workerKey, body: { assignmentToken: staleToken },
  })).status, 409);
  assert.equal((await request(`/api/coordinator/steps/${root.id}/start`, {
    method: 'POST', agentId: WORKER_ID, agentKey: workerKey, body: { assignmentToken: rootWork.assignmentToken },
  })).status, 200);
  assert.equal((await request(`/api/coordinator/steps/${root.id}/submit`, {
    method: 'POST', agentId: WORKER_ID, agentKey: workerKey,
    body: { assignmentToken: staleToken, summary: 'Should not be accepted', evidence: [] },
  })).status, 409);

  const submitted = await request(`/api/coordinator/steps/${root.id}/submit`, {
    method: 'POST',
    agentId: WORKER_ID,
    agentKey: workerKey,
    body: {
      assignmentToken: rootWork.assignmentToken,
      summary: 'Root implementation report',
      evidence: ['test:evidence-root'],
    },
  });
  assert.equal(submitted.status, 202);
  plan = (await responseJson(await request(`/api/coordinator/plans/${planId}`))).plan;
  root = plan.steps.find(step => step.key === 'root');
  child = plan.steps.find(step => step.key === 'child');
  assert.equal(root.status, 'review');
  assert.equal(root.reports.length, 1, 'report should persist with the step submission');
  assert.equal(root.reports[0].summary, 'Root implementation report');
  assert.equal(child.status, 'blocked', 'submission must not unlock dependants before approval');

  // Coordinator approval alone unlocks the child.
  const approval = await request(`/api/coordinator/steps/${root.id}/review`, {
    method: 'POST', body: { decision: 'approve', feedback: 'Evidence is sufficient.' },
  });
  assert.equal(approval.status, 200);
  plan = (await responseJson(await request(`/api/coordinator/plans/${planId}`))).plan;
  root = plan.steps.find(step => step.key === 'root');
  child = plan.steps.find(step => step.key === 'child');
  assert.equal(root.status, 'done');
  assert.equal(child.status, 'assigned');

  const childAgentId = child.assignedAgent;
  const childAgentKey = workerCredentials.get(childAgentId);
  assert.ok(childAgentKey, 'assigned worker must have a registered credential');
  const childWorkResponse = await request(`/api/agents/${childAgentId}/work`, { agentId: childAgentId, agentKey: childAgentKey });
  const childWork = (await responseJson(childWorkResponse)).work.find(step => step.key === 'child');
  assert.ok(childWork?.assignmentToken);
  assert.equal((await request(`/api/coordinator/steps/${child.id}/start`, {
    method: 'POST', agentId: childAgentId, agentKey: childAgentKey,
    body: { assignmentToken: childWork.assignmentToken },
  })).status, 200);
  assert.equal((await request(`/api/coordinator/steps/${child.id}/submit`, {
    method: 'POST', agentId: childAgentId, agentKey: childAgentKey,
    body: { assignmentToken: childWork.assignmentToken, summary: 'Child report', evidence: ['test:evidence-child'] },
  })).status, 202);

  // With maxAttempts=1, coordinator rejection fails the step.
  const rejection = await request(`/api/coordinator/steps/${child.id}/review`, {
    method: 'POST', body: { decision: 'reject', feedback: 'Acceptance criteria were not met.' },
  });
  assert.equal(rejection.status, 200);
  plan = (await responseJson(await request(`/api/coordinator/plans/${planId}`))).plan;
  child = plan.steps.find(step => step.key === 'child');
  assert.equal(child.status, 'failed');
  assert.equal(child.attempts, 1);

  // Retry requires a meaningful reconciliation note and increases the attempt budget.
  assert.equal((await request(`/api/coordinator/steps/${child.id}/retry`, {
    method: 'POST', body: { reason: 'short' },
  })).status, 400);
  const retried = await request(`/api/coordinator/steps/${child.id}/retry`, {
    method: 'POST',
    body: { reason: 'Reviewed journal and reconciled possible side effects.' },
  });
  assert.equal(retried.status, 202);
  plan = (await responseJson(await request(`/api/coordinator/plans/${planId}`))).plan;
  child = plan.steps.find(step => step.key === 'child');
  assert.equal(child.status, 'assigned');
  assert.equal(child.attempts, 2);
  assert.equal(child.maxAttempts, 2);
  assert.equal((await request(`/api/coordinator/steps/${child.id}/retry`, {
    method: 'POST', body: { reason: 'This step is not failed anymore.' },
  })).status, 409);

  const retryAgentId = child.assignedAgent;
  const retryAgentKey = workerCredentials.get(retryAgentId);
  assert.ok(retryAgentKey, 'retried step must have a registered worker credential');
  const retryWorkResponse = await request(`/api/agents/${retryAgentId}/work`, { agentId: retryAgentId, agentKey: retryAgentKey });
  const retryWork = (await responseJson(retryWorkResponse)).work.find(step => step.key === 'child');
  assert.ok(retryWork?.assignmentToken);
  assert.equal((await request(`/api/coordinator/steps/${child.id}/start`, {
    method: 'POST', agentId: retryAgentId, agentKey: retryAgentKey,
    body: { assignmentToken: retryWork.assignmentToken },
  })).status, 200);

  // Expire an unstarted assignment and verify safe requeue plus token fencing.
  const expiringPlanResponse = await request('/api/coordinator/plans', {
    method: 'POST',
    body: {
      objective: 'Verify expired unstarted lease recovery',
      steps: [{ key: 'lease-expiry', title: 'Lease expiry test', description: 'Unstarted work', maxAttempts: 2 }],
    },
  });
  assert.equal(expiringPlanResponse.status, 201);
  const expiringPlan = (await responseJson(expiringPlanResponse)).plan;
  let expiringStep = expiringPlan.steps.find(step => step.key === 'lease-expiry');
  assert.equal(expiringStep.status, 'assigned');
  const expiredWorkerId = expiringStep.assignedAgent;
  const expiredWorkerKey = workerCredentials.get(expiredWorkerId);
  assert.ok(expiredWorkerKey, 'lease assignment must belong to a registered worker');
  const expiringWorkResponse = await request(`/api/agents/${expiredWorkerId}/work`, {
    agentId: expiredWorkerId, agentKey: expiredWorkerKey,
  });
  const expiringWork = (await responseJson(expiringWorkResponse)).work.find(step => step.id === expiringStep.id);
  assert.ok(expiringWork?.assignmentToken);
  testDb.prepare("UPDATE coordination_steps SET lease_expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), expiringStep.id);

  const leaseDeadline = Date.now() + 12000;
  let leaseRecovered = false;
  while (Date.now() < leaseDeadline) {
    const latestPlan = (await responseJson(await request(`/api/coordinator/plans/${expiringPlan.id}`))).plan;
    expiringStep = latestPlan.steps.find(step => step.id === expiringStep.id);
    const journalResponse = await request(`/api/coordinator/execution-journal?planId=${encodeURIComponent(expiringPlan.id)}&limit=100`);
    const leaseJournal = await responseJson(journalResponse);
    if (leaseJournal.events.some(event =>
      event.eventType === 'coordination.step.lease_expired' && event.stepId === expiringStep.id
    )) {
      leaseRecovered = true;
      break;
    }
    await sleep(250);
  }
  assert.equal(leaseRecovered, true, 'lease sweeper should journal expiry within its sweep interval');
  assert.ok(['ready', 'assigned'].includes(expiringStep.status), 'unstarted expired work should be safely requeued');
  assert.equal(expiringStep.attempts, 1, 'lease expiry should not silently consume another execution attempt');
  assert.equal((await request(`/api/coordinator/steps/${expiringStep.id}/start`, {
    method: 'POST', agentId: expiredWorkerId, agentKey: expiredWorkerKey,
    body: { assignmentToken: expiringWork.assignmentToken },
  })).status, 409, 'expired assignment token must not start work after recovery');

  // Restart with a step in progress: it must fail closed pending coordinator reconciliation.
  await stopApi();
  await startApi();
  plan = (await responseJson(await request(`/api/coordinator/plans/${planId}`))).plan;
  child = plan.steps.find(step => step.key === 'child');
  assert.equal(child.status, 'failed');
  assert.match(child.reviewFeedback, /API restart during execution/i);

  const journalResponse = await request(`/api/coordinator/execution-journal?planId=${encodeURIComponent(planId)}&limit=200`);
  assert.equal(journalResponse.status, 200);
  const journal = await responseJson(journalResponse);
  const eventTypes = new Set(journal.events.map(event => event.eventType));
  assert.ok(eventTypes.has('coordination.plan.created'));
  assert.ok(eventTypes.has('coordination.step.started'));
  assert.ok(eventTypes.has('coordination.step.submitted'));
  assert.ok(eventTypes.has('coordination.step.reviewed'));
  assert.ok(eventTypes.has('coordination.step.retry_authorized'));
  assert.ok(eventTypes.has('coordination.step.recovered'));
});
