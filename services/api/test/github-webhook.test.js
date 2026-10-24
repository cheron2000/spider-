import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const WEBHOOK_SECRET = 'test-github-webhook-secret-long-enough-123456';
let apiProcess;
let baseUrl;
let tempDirectory;
let databasePath;
let output = '';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startApi() {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  output = '';
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    SPIDER_DB_PATH: databasePath,
    SPIDER_COORDINATOR_API_KEY: 'test-coordinator-key-long-enough-for-webhook-tests',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_TOKEN: '',
    GITHUB_REPOSITORY: '',
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
  apiProcess = spawn(process.execPath, ['services/api/src/index.js'], {
    cwd: REPO_ROOT,
    env,
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

function signature(body) {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

async function postWebhook(body, suppliedSignature) {
  const headers = { 'content-type': 'application/json', 'x-github-event': 'ping' };
  if (suppliedSignature !== undefined) headers['x-hub-signature-256'] = suppliedSignature;
  return fetch(`${baseUrl}/api/webhooks/github`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(5000),
  });
}

test('GitHub webhook accepts a valid HMAC signature over the exact raw request body', { timeout: 30000 }, async t => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'spider-webhook-test-'));
  databasePath = path.join(tempDirectory, 'spider-webhook-test.db');
  t.after(async () => {
    await stopApi();
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });
  await startApi();

  const body = JSON.stringify({ zen: 'Webhook signature integration test', hook_id: 123 });
  const accepted = await postWebhook(body, signature(body));
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true });

  const invalid = await postWebhook(body, 'sha256=' + '0'.repeat(64));
  assert.equal(invalid.status, 401);
  assert.match((await invalid.json()).error, /invalid webhook signature/i);

  const missing = await postWebhook(body);
  assert.equal(missing.status, 401);

  const malformedBody = '{invalid-json';
  const malformed = await postWebhook(malformedBody, signature(malformedBody));
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /invalid json/i);
});
