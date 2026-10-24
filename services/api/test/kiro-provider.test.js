import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiroAdapter } from '../src/providers/kiro.js';

test('Kiro adapter uses the CLI executable and non-interactive chat mode', () => {
  const adapter = createKiroAdapter();
  const prompt = 'Execute a deterministic Spider task.';

  assert.equal(adapter.commandDefault, 'kiro-cli');
  assert.deepEqual(adapter.argsFor(prompt), ['chat', '--no-interactive', prompt]);
});
