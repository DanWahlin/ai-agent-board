import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTaskLifecycleTransition,
  isValidTaskLifecycleState,
  TASK_LIFECYCLE_TRANSITIONS,
  transitionTaskLifecycle,
  VALID_COLUMNS,
  VALID_TASK_LIFECYCLE_STATES,
} from '@ai-agent-board/shared/constants.js';
import type { TaskLifecycleState } from '@ai-agent-board/shared/types.js';

test('publishes the exact four-state lifecycle and an explicit 4 × 4 matrix', () => {
  assert.deepEqual(VALID_TASK_LIFECYCLE_STATES, ['Draft', 'Inbox', 'Active', 'Done']);
  assert.equal(Object.keys(TASK_LIFECYCLE_TRANSITIONS).length, 4);
  for (const from of VALID_TASK_LIFECYCLE_STATES) {
    assert.equal(Object.keys(TASK_LIFECYCLE_TRANSITIONS[from]).length, 4);
    for (const to of VALID_TASK_LIFECYCLE_STATES) {
      const result = getTaskLifecycleTransition(from, to);
      const transition = TASK_LIFECYCLE_TRANSITIONS[from][to];
      assert.equal(result.ok, transition !== null, `${from} → ${to}`);
      if (transition) {
        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.transition, transition);
      }
    }
  }
});

test('same-state requests are successful no-ops', () => {
  for (const state of VALID_TASK_LIFECYCLE_STATES) {
    const result = transitionTaskLifecycle(state, state);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.state, state);
      assert.equal(result.transition.action, 'noop');
    }
  }
});

test('key lifecycle paths have explicit actions and do not trigger execution', () => {
  const expected: [TaskLifecycleState, TaskLifecycleState, string][] = [
    ['Draft', 'Inbox', 'submit'],
    ['Inbox', 'Active', 'qualify'],
    ['Active', 'Inbox', 'retry'],
    ['Done', 'Inbox', 'reopen'],
  ];
  for (const [from, to, action] of expected) {
    const result = getTaskLifecycleTransition(from, to);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.transition.action, action);
  }
  assert.equal(getTaskLifecycleTransition('Draft', 'Inbox').ok, true);
  assert.equal(getTaskLifecycleTransition('Inbox', 'Active').ok, true);
});

test('Active → Done requires explicit confirmation and cannot infer completion from incidental context', () => {
  const withoutConfirmation = transitionTaskLifecycle('Active', 'Done', {});
  assert.equal(withoutConfirmation.ok, false);
  if (!withoutConfirmation.ok) {
    assert.equal(withoutConfirmation.error.code, 'completion_confirmation_required');
    assert.equal(withoutConfirmation.error.from, 'Active');
    assert.equal(withoutConfirmation.error.to, 'Done');
  }
  const complete = transitionTaskLifecycle('Active', 'Done', { completionConfirmed: true });
  assert.equal(complete.ok, true);
  if (complete.ok) assert.equal(complete.transition.action, 'complete');
});

test('invalid transitions reject with stable code and preserve from/to', () => {
  const invalid: [TaskLifecycleState, TaskLifecycleState][] = [
    ['Draft', 'Active'], ['Draft', 'Done'],
    ['Inbox', 'Done'],
    ['Active', 'Draft'],
    ['Done', 'Draft'], ['Done', 'Active'],
  ];
  for (const [from, to] of invalid) {
    const result = transitionTaskLifecycle(from, to, { completionConfirmed: true });
    assert.equal(result.ok, false, `${from} → ${to}`);
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid_transition');
      assert.equal(result.error.from, from);
      assert.equal(result.error.to, to);
    }
  }
});

test('unknown values fail closed without legacy ColumnId coercion', () => {
  assert.equal(isValidTaskLifecycleState('backlog'), false);
  assert.deepEqual(VALID_COLUMNS, ['backlog', 'in-progress', 'review', 'done']);
  for (const [from, to] of [['backlog', 'Active'], ['Draft', 'review'], ['draft', 'Inbox']]) {
    const result = getTaskLifecycleTransition(from, to);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid_state');
      assert.equal(result.error.from, from);
      assert.equal(result.error.to, to);
    }
  }
});
