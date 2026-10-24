import test from 'node:test';
import assert from 'node:assert/strict';
import { isCoordinatorAuthenticated, labelState, stateClass } from '../src/dashboardState.js';

test('execution states map to stable CSS classes', () => {
  assert.equal(stateClass('done'), 'done');
  assert.equal(stateClass('completed'), 'done');
  assert.equal(stateClass('in_progress'), 'active');
  assert.equal(stateClass('assigned'), 'active');
  assert.equal(stateClass('review'), 'review');
  assert.equal(stateClass('failed'), 'failed');
  assert.equal(stateClass('unknown-state'), 'todo');
});

test('execution state labels are readable', () => {
  assert.equal(labelState('in_progress'), 'in progress');
  assert.equal(labelState('done'), 'done');
  assert.equal(labelState(''), 'unknown');
});

test('live status requires both a connected socket and authenticated health', () => {
  assert.equal(isCoordinatorAuthenticated(true, { ok: true }), true);
  assert.equal(isCoordinatorAuthenticated(false, { ok: true }), false);
  assert.equal(isCoordinatorAuthenticated(true, { ok: false }), false);
  assert.equal(isCoordinatorAuthenticated(true, null), false);
});
