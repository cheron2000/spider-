import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProviderRuntimeManager } from '../src/providers/runtime.js';

function makeAdapter({
  id,
  enabled = true,
  workspace,
  canonicalPath,
  status = 'ready',
  runTask = async () => ({ summary: 'completed', evidence: [] }),
} = {}) {
  let calls = 0;
  return {
    id,
    label: id,
    description: 'test provider',
    enabled,
    workspace,
    maxConcurrentTasks: 1,
    healthState: {
      status,
      workspaceConfigured: Boolean(workspace),
      workspaceCanonicalPath: canonicalPath,
      reason: null,
      authState: 'not-probed',
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
}

test('enabled providers sharing the same canonical workspace are blocked from dispatch', async () => {
  const sharedCanonicalPath = path.resolve('/tmp/spider/shared-workspace');
  const first = makeAdapter({
    id: 'codex',
    workspace: '/tmp/spider/codex',
    canonicalPath: sharedCanonicalPath,
  });
  const second = makeAdapter({
    id: 'copilot',
    workspace: '/tmp/spider/copilot',
    canonicalPath: sharedCanonicalPath,
  });
  const runtime = new ProviderRuntimeManager([first, second]);

  const conflict = runtime.workspaceConflict('codex');
  assert.match(conflict, /shared with enabled provider copilot/i);
  assert.equal(runtime.canAcceptWork('codex'), false);
  assert.equal(runtime.snapshot('codex').status, 'offline');
  assert.match(runtime.snapshot('codex').reason, /separate workspace directory/i);
  await assert.rejects(runtime.dispatch('codex', { prompt: 'must not run' }), /shared with enabled provider copilot/i);
  assert.equal(first.runTaskCalls, 0, 'a conflicting provider must not execute work');
  assert.equal(runtime.activeCount('codex'), 0, 'a rejected dispatch must not consume capacity');
});

test('disabled providers do not cause workspace collision blocks', () => {
  const canonicalPath = path.resolve('/tmp/spider/shared-workspace');
  const enabled = makeAdapter({
    id: 'codex',
    workspace: '/tmp/spider/codex',
    canonicalPath,
  });
  const disabled = makeAdapter({
    id: 'copilot',
    enabled: false,
    workspace: '/tmp/spider/copilot',
    canonicalPath,
  });
  const runtime = new ProviderRuntimeManager([enabled, disabled]);

  assert.equal(runtime.workspaceConflict('codex'), null);
  assert.equal(runtime.canAcceptWork('codex'), true);
  assert.equal(runtime.snapshot('codex').status, 'ready');
});

test('equivalent workspace paths are normalized before collision comparison', () => {
  const first = makeAdapter({
    id: 'codex',
    workspace: path.join('/tmp/spider', 'shared', '..', 'workspace'),
  });
  const second = makeAdapter({
    id: 'copilot',
    workspace: path.join('/tmp/spider', 'workspace'),
  });
  const runtime = new ProviderRuntimeManager([first, second]);

  assert.match(runtime.workspaceConflict('codex'), /shared with enabled provider copilot/i);
});
