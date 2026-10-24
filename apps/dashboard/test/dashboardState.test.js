import test from 'node:test';
import assert from 'node:assert/strict';
import { isCoordinatorAuthenticated } from '../src/dashboardState.js';

test('live status requires socket and authenticated health', () => {
  assert.equal(isCoordinatorAuthenticated(true, { ok: true }), true);
  assert.equal(isCoordinatorAuthenticated(false, { ok: true }), false);
  assert.equal(isCoordinatorAuthenticated(true, { ok: false }), false);
});
