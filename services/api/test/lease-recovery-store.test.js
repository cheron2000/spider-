import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('lease recovery defers an expired assignment while its provider invocation is active', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spider-lease-store-'));
  const previousDbPath = process.env.SPIDER_DB_PATH;
  process.env.SPIDER_DB_PATH = path.join(directory, 'spider.db');

  try {
    const { CoordinationStore } = await import('../src/agentRegistry.js?active-lease-test');
    const store = new CoordinationStore();
    const now = new Date().toISOString();
    const stepId = 'active-provider-step';
    const planId = 'active-provider-plan';

    store.createPlan({
      id: planId,
      objective: 'Verify active provider lease deferral',
      createdAt: now,
      updatedAt: now,
      steps: [{
        id: stepId,
        key: 'active-provider',
        title: 'Active provider invocation',
        description: 'Simulate a provider invocation that has not returned yet',
        dependsOn: [],
        requiredCapabilities: [],
        maxAttempts: 2,
      }],
    });

    const expiredAt = new Date(Date.now() - 1000).toISOString();
    store.updateStep({
      ...store.getStep(stepId),
      status: 'in_progress',
      assignedAgent: 'provider-worker',
      attempts: 1,
      assignedAt: now,
      startedAt: now,
      leaseExpiresAt: expiredAt,
      lastActivityAt: now,
      assignmentToken: 'active-provider-assignment-token-123456789',
      updatedAt: now,
    });

    const deferred = store.recoverExpiredLeases(new Date().toISOString(), {
      excludeStepIds: new Set([stepId]),
    });
    assert.deepEqual(deferred, [], 'active provider work must be excluded from lease recovery');

    const stillActive = store.getStep(stepId);
    assert.equal(stillActive.status, 'in_progress');
    assert.equal(stillActive.assignedAgent, 'provider-worker');
    assert.equal(stillActive.assignmentToken, 'active-provider-assignment-token-123456789');

    const recovered = store.recoverExpiredLeases(new Date().toISOString());
    assert.equal(recovered.length, 1, 'expired lease should be reconciled after the active invocation is no longer excluded');
    assert.equal(recovered[0].step.status, 'failed', 'in-progress work must fail closed pending side-effect reconciliation');
    assert.equal(recovered[0].step.assignedAgent, null);
    assert.equal(recovered[0].step.assignmentToken, null);
    assert.match(recovered[0].step.reviewFeedback, /side effects/i);
  } finally {
    if (previousDbPath === undefined) delete process.env.SPIDER_DB_PATH;
    else process.env.SPIDER_DB_PATH = previousDbPath;
    // The test database handle belongs to this short-lived node:test worker.
    await rm(directory, { recursive: true, force: true });
  }
});
