import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CommandProviderAdapter, runProcess, safeChildEnv} from '../src/providers/base.js';

const ENV_KEYS = [
  'SPIDER_TEST_PROVIDER_ENABLED',
  'SPIDER_TEST_PROVIDER_COMMAND',
  'SPIDER_TEST_PROVIDER_WORKSPACE',
  'SPIDER_TEST_PROVIDER_TIMEOUT_MS',
  'SPIDER_TEST_PROVIDER_PASSTHROUGH_ENV',
];

async function withAdapter(t, argsFor) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'spider-provider-contract-'));
  process.env.SPIDER_TEST_PROVIDER_ENABLED = 'true';
  process.env.SPIDER_TEST_PROVIDER_COMMAND = process.execPath;
  process.env.SPIDER_TEST_PROVIDER_WORKSPACE = workspace;
  process.env.SPIDER_TEST_PROVIDER_TIMEOUT_MS = '10000';
  delete process.env.SPIDER_TEST_PROVIDER_PASSTHROUGH_ENV;

  const adapter = new CommandProviderAdapter({
    id: 'test-provider',
    label: 'Test Provider',
    commandDefault: process.execPath,
    argsFor,
    description: 'Fake CLI for isolated adapter contract tests',
  });

  t.after(async () => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(workspace, {recursive: true, force: true});
  });

  const health = await adapter.health();
  assert.equal(health.status, 'ready', health.reason || 'fake CLI should be probeable');
  return adapter;
}

const work = {
  planObjective: 'Validate the provider adapter contract.',
  title: 'Run a deterministic fake command',
  description: 'No network or external provider should be contacted.',
  key: 'fake-command',
  attempt: 1,
  maxAttempts: 1,
  dependsOn: [],
};

test('CommandProviderAdapter returns a parsed success report from a fake CLI', async t => {
  const adapter = await withAdapter(t, () => [
    '-e',
    'process.stdout.write(JSON.stringify({type:"result",result:"fake provider completed"}))',
  ]);

  const result = await adapter.runTask(work);
  assert.equal(result.success, true);
  assert.equal(result.summary, 'fake provider completed');
  assert.ok(result.evidence.includes('provider:test-provider'));
  assert.equal(result.provenance.processExitCode, 0);
  assert.equal(result.provenance.resultStatus, 'zero-exit-reported-success');
});

test('CommandProviderAdapter preserves nonzero exit output as a failed result', async t => {
  const adapter = await withAdapter(t, () => [
    '-e',
    'process.stdout.write("partial output before failure"); process.exit(7)',
  ]);

  const result = await adapter.runTask(work);
  assert.equal(result.success, false);
  assert.match(result.summary, /partial output before failure/);
  assert.equal(result.provenance.processExitCode, 7);
  assert.equal(result.provenance.resultStatus, 'nonzero-exit');
});

test('CommandProviderAdapter marks provider-reported failures even with exit code zero', async t => {
  const adapter = await withAdapter(t, () => [
    '-e',
    'process.stdout.write(JSON.stringify({type:"turn.failed",error:{message:"fake task failed"}}))',
  ]);

  const result = await adapter.runTask(work);
  assert.equal(result.success, false);
  assert.ok(result.evidence.includes('provider-cli-status:failure'));
  assert.equal(result.provenance.processExitCode, 0);
  assert.equal(result.provenance.resultStatus, 'provider-reported-failure');
});

test('CommandProviderAdapter blocks authentication failures until explicitly reset', async t => {
  const adapter = await withAdapter(t, () => [
    '-e',
    'process.stderr.write("Not authenticated"); process.exit(1)',
  ]);

  await assert.rejects(adapter.runTask(work), /Provider authentication failed/);
  const blocked = await adapter.health();
  assert.equal(blocked.status, 'offline');
  assert.equal(blocked.authState, 'failed');

  const reset = await adapter.reset();
  assert.equal(reset.status, 'ready');
  assert.equal(reset.authState, 'not-probed');
});

test('runProcess passes shell metacharacters as literal arguments', async () => {
  const literal = 'literal; process.exit(99) && echo injected';
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', literal],
    {
      cwd: process.cwd(),
      env: safeChildEnv(),
      timeoutMs: 2000,
      maxOutputChars: 1000,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, JSON.stringify([literal]));
});
