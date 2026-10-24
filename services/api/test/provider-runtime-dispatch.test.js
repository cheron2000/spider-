import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRuntimeManager } from '../src/providers/runtime.js';

function makeAdapter({
  id = 'test-provider',
  maxConcurrentTasks = 1,
  runTask = async () => ({ summary: 'completed', evidence: [], success: true }),
} = {}) {
  let calls = 0;
  const adapter = {
    id,
    label: id,
    description: 'Deterministic provider runtime test adapter',
    enabled: true,
    maxConcurrentTasks,
    healthState: {
      status: 'ready',
      workspaceConfigured: false,
      authState: 'not-probed',
      reason: null,
    },
    async health() {
      return this.healthState;
    },
    async runTask(work) {
      calls += 1;
      return runTask(work);
    },
    get runTaskCalls() {
      return calls;
    },
  };
  return adapter;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('runtime rejects a concurrent dispatch beyond provider capacity and releases capacity afterward', async () => {
  const gate = deferred();
  const adapter = makeAdapter({
    runTask: () => gate.promise,
  });
  const runtime = new ProviderRuntimeManager([adapter]);

  const firstDispatch = runtime.dispatch(adapter.id, { prompt: 'first task' });
  assert.equal(runtime.activeCount(adapter.id), 1);
  await assert.rejects(
    runtime.dispatch(adapter.id, { prompt: 'second task' }),
    /concurrency limit reached/i,
  );
  assert.equal(adapter.runTaskCalls, 1, 'only the first dispatch may reach the provider');
  assert.equal(runtime.activeCount(adapter.id), 1);

  gate.resolve({ summary: 'first completed', evidence: [], success: true });
  const result = await firstDispatch;
  assert.equal(result.summary, 'first completed');
  assert.equal(adapter.runTaskCalls, 1);
  assert.equal(runtime.activeCount(adapter.id), 0, 'completed dispatch must release capacity');
  assert.equal(runtime.snapshot(adapter.id).status, 'ready');
});

test('runtime rejects malformed completion reports and releases capacity', async () => {
  const adapter = makeAdapter({
    runTask: async () => ({ summary: '   ', evidence: [], success: true }),
  });
  const runtime = new ProviderRuntimeManager([adapter]);

  await assert.rejects(
    runtime.dispatch(adapter.id, { prompt: 'malformed report' }),
    /empty or invalid completion report/i,
  );
  assert.equal(adapter.runTaskCalls, 1);
  assert.equal(runtime.activeCount(adapter.id), 0, 'failed dispatch must release capacity');
  assert.equal(runtime.snapshot(adapter.id).status, 'offline');
});

test('runtime redacts credentials from summaries, evidence, and changed-file references', async () => {
  const secret = 'sk-abcdefghijklmnop';
  const adapter = makeAdapter({
    runTask: async () => ({
      summary: `Completed with credential ${secret}`,
      evidence: [`provider output contained ${secret}`],
      success: true,
      provenance: {
        processExitCode: 0,
        resultStatus: 'success',
        changedFileRefs: [`artifact path ${secret}`],
      },
    }),
  });
  const runtime = new ProviderRuntimeManager([adapter]);

  const result = await runtime.dispatch(adapter.id, { prompt: 'redaction test' });
  assert.doesNotMatch(result.summary, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(result.evidence.join(' '), /sk-abcdefghijklmnop/);
  assert.doesNotMatch(result.provenance.changedFileRefs.join(' '), /sk-abcdefghijklmnop/);
  assert.match(result.summary, /REDACTED/);
  assert.equal(runtime.activeCount(adapter.id), 0);
});
