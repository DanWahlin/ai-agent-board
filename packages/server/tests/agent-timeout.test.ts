import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAgentTimeoutMs, resolveTaskTimeoutMs } from '../src/services/agent-timeout.js';
import { buildTask, validateTaskFields } from '../src/routes/helpers.js';

test('defaults agent runs to 60 minutes when AGENT_TIMEOUT_MS is unset', () => {
  const previous = process.env.AGENT_TIMEOUT_MS;
  delete process.env.AGENT_TIMEOUT_MS;
  try {
    assert.equal(defaultAgentTimeoutMs(), 60 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TIMEOUT_MS;
    else process.env.AGENT_TIMEOUT_MS = previous;
  }
});

test('uses a persisted per-task timeout override', () => {
  assert.equal(resolveTaskTimeoutMs({ timeoutMinutes: 90 }), 90 * 60 * 1000);
});

test('validates timeout bounds and preserves the accepted value', () => {
  const valid = { title: 'Review', repoPath: '/tmp/repo', timeoutMinutes: 120 };
  assert.equal(validateTaskFields(valid), null);
  assert.equal(buildTask(valid).timeoutMinutes, 120);
  assert.match(validateTaskFields({ ...valid, timeoutMinutes: 0 }) || '', /between 1 and 240/);
  assert.match(validateTaskFields({ ...valid, timeoutMinutes: 12.5 }) || '', /integer/);
  assert.match(validateTaskFields({ ...valid, timeoutMinutes: 241 }) || '', /between 1 and 240/);
});
