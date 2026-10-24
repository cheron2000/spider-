import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('GitHubIssueStore persists issues, claims, progress and completion across database reopen', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spider-issue-store-'));
  const previousDbPath = process.env.SPIDER_DB_PATH;
  process.env.SPIDER_DB_PATH = path.join(directory, 'spider.db');
  let initialModule;
  let reopenedModule;

  try {
    initialModule = await import('../src/agentRegistry.js?issue-store-test');
    const store = new initialModule.GitHubIssueStore();

    const task = {
      id: 'issue-101',
      number: 101,
      title: 'Durable task test',
      body: 'Verify SQLite durability',
      url: 'https://github.com/example/repo/issues/101',
      state: 'open',
      status: 'todo',
      labels: ['agent-task', 'priority:high'],
      assigneeAgent: null,
      priority: 'high',
      updatedAt: new Date().toISOString(),
    };
    store.upsert(task);
    assert.equal(store.count(), 1);
    assert.equal(store.get('issue-101').title, 'Durable task test');
    assert.equal(store.get(101).id, 'issue-101');

    const claimed = store.claim('issue-101', 'test-agent', new Date().toISOString());
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.assigneeAgent, 'test-agent');
    assert.ok(claimed.claimedAt);

    const losingClaim = store.claim('issue-101', 'second-agent', new Date().toISOString());
    assert.equal(losingClaim, null, 'a second agent must not claim an already claimed task');

    claimed.progress = { percent: 45, message: 'Working on feature', at: new Date().toISOString() };
    store.upsert(claimed);

    const syncedFromGithub = [{
      id: 'issue-101',
      number: 101,
      title: 'Durable task test (updated from GitHub)',
      body: 'Verify SQLite durability',
      url: 'https://github.com/example/repo/issues/101',
      state: 'open',
      status: 'todo',
      labels: ['agent-task', 'priority:high'],
      assigneeAgent: null,
      priority: 'high',
      updatedAt: new Date().toISOString(),
    }];
    store.syncAll(syncedFromGithub);
    const afterSync = store.get('issue-101');
    assert.equal(afterSync.title, 'Durable task test (updated from GitHub)');
    assert.equal(afterSync.status, 'in_progress');
    assert.equal(afterSync.assigneeAgent, 'test-agent');
    assert.equal(afterSync.progress.percent, 45);

    afterSync.status = 'review';
    afterSync.completionReport = {
      summary: 'Task complete and ready for review',
      evidence: ['https://example.com/pr/1'],
      at: new Date().toISOString()
    };
    store.upsert(afterSync);
    initialModule.closeDatabase();

    // Import a fresh module instance against the same on-disk SQLite database.
    reopenedModule = await import('../src/agentRegistry.js?issue-store-test-reopened');
    const reopenedStore = new reopenedModule.GitHubIssueStore();
    assert.equal(reopenedStore.count(), 1);
    const reopened = reopenedStore.get('issue-101');
    assert.equal(reopened.status, 'review');
    assert.equal(reopened.assigneeAgent, 'test-agent');
    assert.equal(reopened.progress.percent, 45);
    assert.equal(reopened.completionReport.summary, 'Task complete and ready for review');
    assert.equal(reopened.completionReport.evidence[0], 'https://example.com/pr/1');
  } finally {
    try { reopenedModule?.closeDatabase(); } catch {}
    try { initialModule?.closeDatabase(); } catch {}
    if (previousDbPath === undefined) delete process.env.SPIDER_DB_PATH;
    else process.env.SPIDER_DB_PATH = previousDbPath;
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
