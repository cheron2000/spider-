import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('GitHubIssueStore persists issues, claims, progress and survives restarts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spider-issue-store-'));
  const previousDbPath = process.env.SPIDER_DB_PATH;
  process.env.SPIDER_DB_PATH = path.join(directory, 'spider.db');

  try {
    const { GitHubIssueStore, closeDatabase } = await import('../src/agentRegistry.js?issue-store-test');
    const store = new GitHubIssueStore();

    // 1. Upsert a task
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

    const fetched = store.get('issue-101');
    assert.equal(fetched.title, 'Durable task test');
    assert.equal(fetched.priority, 'high');
    assert.equal(fetched.status, 'todo');

    // 2. Also test fetching by number
    const fetchedByNum = store.get(101);
    assert.equal(fetchedByNum.id, 'issue-101');

    // 3. Claim and update progress
    fetched.status = 'in_progress';
    fetched.assigneeAgent = 'test-agent';
    fetched.claimedAt = new Date().toISOString();
    fetched.progress = { percent: 45, message: 'Working on feature', at: new Date().toISOString() };
    store.upsert(fetched);

    const claimed = store.get('issue-101');
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.assigneeAgent, 'test-agent');
    assert.equal(claimed.progress.percent, 45);

    // 4. GitHub syncAll preserves local claim and progress if GitHub issue is still open
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
    assert.equal(afterSync.status, 'in_progress', 'local in-progress status preserved across sync');
    assert.equal(afterSync.assigneeAgent, 'test-agent', 'local assignee preserved across sync');
    assert.equal(afterSync.progress.percent, 45, 'local progress preserved across sync');

    // 5. Submit completion report
    afterSync.status = 'review';
    afterSync.completionReport = {
      summary: 'Task complete and ready for review',
      evidence: ['https://example.com/pr/1'],
      at: new Date().toISOString()
    };
    store.upsert(afterSync);

    const completed = store.get('issue-101');
    assert.equal(completed.status, 'review');
    assert.equal(completed.completionReport.summary, 'Task complete and ready for review');

    closeDatabase();
  } finally {
    try {
      const module = await import('../src/agentRegistry.js?issue-store-test');
      module.closeDatabase?.();
    } catch {}
    if (previousDbPath === undefined) delete process.env.SPIDER_DB_PATH;
    else process.env.SPIDER_DB_PATH = previousDbPath;
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
