import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedTimeout,
  extractCliText,
  inspectCliOutcome,
  redactSecrets,
  safeChildEnv,
} from '../src/providers/base.js';

test('redactSecrets removes common credential formats from reports', () => {
  const input = 'sk-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnopqrstuvwxyz api_key=plain-secret';
  const result = redactSecrets(input);
  assert.doesNotMatch(result, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(result, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(result, /Bearer abcdefghijklmnopqrstuvwxyz/);
  assert.match(result, /REDACTED/);
});

test('extractCliText extracts structured assistant completion records', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Completed the requested change.' } }),
    JSON.stringify({ type: 'result', result: 'Validated the output.' }),
  ].join('\n');
  const result = extractCliText(stdout);
  assert.match(result, /Completed the requested change/);
  assert.match(result, /Validated the output/);
});

test('inspectCliOutcome recognizes provider-reported failures', () => {
  const result = inspectCliOutcome(JSON.stringify({
    type: 'turn.failed',
    error: { message: 'Permission denied by provider.' },
  }));
  assert.equal(result.failed, true);
  assert.match(result.reason, /Permission denied/);
});

test('inspectCliOutcome does not misclassify transient reconnect notices as final failures', () => {
  const result = inspectCliOutcome(JSON.stringify({
    type: 'error',
    message: 'Temporary reconnecting; retrying request.',
  }));
  assert.equal(result.failed, false);
});

test('safeChildEnv only passes baseline variables plus explicitly allowlisted variables', () => {
  const allowKey = 'SPIDER_TEST_EXPLICIT_PASSTHROUGH';
  const secretKey = 'SPIDER_TEST_MUST_NOT_LEAK';
  const previousAllow = process.env[allowKey];
  const previousSecret = process.env[secretKey];
  try {
    process.env[allowKey] = 'allowed-value';
    process.env[secretKey] = 'should-not-be-present';
    const env = safeChildEnv(allowKey);
    assert.equal(env[allowKey], 'allowed-value');
    assert.equal(Object.hasOwn(env, secretKey), false);
    assert.ok(env.PATH);
  } finally {
    if (previousAllow === undefined) delete process.env[allowKey];
    else process.env[allowKey] = previousAllow;
    if (previousSecret === undefined) delete process.env[secretKey];
    else process.env[secretKey] = previousSecret;
  }
});

test('boundedTimeout clamps invalid and extreme provider timeout values', () => {
  assert.equal(boundedTimeout('bad-value', 12345), 12345);
  assert.equal(boundedTimeout('1'), 10000);
  assert.equal(boundedTimeout('9999999'), 900000);
  assert.equal(boundedTimeout('45000'), 45000);
});

test('inspectCliOutcome recognizes nested failed run records', () => {
  const result = inspectCliOutcome(JSON.stringify({
    type: 'workflow.result',
    data: { run: { status: 'failed', reason: 'Provider returned an invalid response.' } },
  }));
  assert.equal(result.failed, true);
  assert.match(result.reason, /invalid response/i);
});
