import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachSessionToTask,
  createSession,
  createSessionResult,
  createTaskSessionAssociation,
  getSessionStateTransition,
  recordSessionResult,
  SESSION_STATE_TRANSITIONS,
  transitionSession,
  transitionSessionState,
  VALID_SESSION_STATES,
  validateCreateSession,
} from '@ai-agent-board/shared/constants.js';
import type { Session, SessionContractResult, SessionState } from '@ai-agent-board/shared/types.js';

function value<T>(result: SessionContractResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected success');
  return result.value;
}

function rejects(result: SessionContractResult<unknown>, code: string, path?: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected validation failure');
  assert.ok(result.errors.some(error => error.code === code && (path === undefined || error.path === path)), JSON.stringify(result.errors));
}

const roleSnapshot = {
  roleId: 'role-builder',
  name: 'Builder',
  responsibility: 'Implement the requested change.',
  instructions: 'Use focused tests.',
  execution: { provider: 'codex' as const, model: 'custom/model' },
};

function session(id: string, taskId = 'task-1') {
  return value(createSession('Active', {
    id,
    taskId,
    createdAt: 100,
    roleExecutionSnapshot: roleSnapshot,
    executionAttemptId: `attempt-${id}`,
  }));
}

test('publishes all five states and an explicit 5 × 5 matrix', () => {
  assert.deepEqual(VALID_SESSION_STATES, ['Ready', 'Running', 'Waiting', 'Completed', 'Failed']);
  for (const from of VALID_SESSION_STATES) {
    assert.equal(Object.keys(SESSION_STATE_TRANSITIONS[from]).length, 5);
    for (const to of VALID_SESSION_STATES) {
      const result = getSessionStateTransition(from, to);
      assert.equal(result.ok, SESSION_STATE_TRANSITIONS[from][to] !== null, `${from} → ${to}`);
    }
  }
});

test('creates an independent Ready Session only for an Active Task', () => {
  const created = session('session-1');
  assert.equal(created.id, 'session-1');
  assert.equal(created.taskId, 'task-1');
  assert.notEqual(created.id, created.taskId);
  assert.equal(created.state, 'Ready');
  assert.equal(created.updatedAt, 100);
  assert.equal(created.startedAt, null);
  assert.equal(created.endedAt, null);
  assert.deepEqual(created.roleExecutionSnapshot, roleSnapshot);
  assert.equal(created.sdkSessionId, null);
  rejects(createSession('Inbox', { id: 'session-2', taskId: 'task-1', createdAt: 101 }), 'task_not_active', 'taskState');
  rejects(validateCreateSession('Active', { id: 'task-1', taskId: 'task-1', createdAt: 101 }), 'same_as_task', 'id');
  rejects(validateCreateSession('Active', { id: 'session-1', taskId: 'task-1', createdAt: 101 }, ['session-1']), 'duplicate_id', 'id');
  rejects(validateCreateSession('Active', { id: 'session-2', taskId: 'task-1', createdAt: 101, sdkSessionId: ' ' }), 'blank', 'sdkSessionId');
});

test('captures a validated immutable Role execution snapshot', () => {
  const mutableSnapshot = {
    roleId: 'role-builder',
    name: 'Builder',
    responsibility: 'Implement the requested change.',
    instructions: 'Use focused tests.',
    execution: { provider: 'codex' as const, model: 'custom/model' },
  };
  const created = value(createSession('Active', {
    id: 'session-snapshot', taskId: 'task-1', createdAt: 100, roleExecutionSnapshot: mutableSnapshot,
  }));
  mutableSnapshot.name = 'Changed after session creation';
  mutableSnapshot.execution.model = 'different/model';
  assert.equal(created.roleExecutionSnapshot?.name, 'Builder');
  assert.equal(created.roleExecutionSnapshot?.execution.model, 'custom/model');
  assert.equal(Object.isFrozen(created.roleExecutionSnapshot), true);
  assert.equal(Object.isFrozen(created.roleExecutionSnapshot?.execution), true);

  rejects(createSession('Active', {
    id: 'session-invalid-snapshot', taskId: 'task-1', createdAt: 101,
    roleExecutionSnapshot: { ...roleSnapshot, execution: { provider: 'unsupported' } },
  }), 'invalid_type', 'roleExecutionSnapshot.execution.provider');
});

test('state transitions support start, wait, resume and terminal success/failure while preserving timestamps', () => {
  const ready = session('session-1');
  const running = value(transitionSession(ready, 'Running', 110));
  assert.equal(running.startedAt, 110);
  assert.equal(running.endedAt, null);
  const waiting = value(transitionSession(running, 'Waiting', 120));
  assert.equal(waiting.updatedAt, 120);
  const resumed = value(transitionSession(waiting, 'Running', 130));
  assert.equal(resumed.startedAt, 110);
  const completed = value(transitionSession(resumed, 'Completed', 140));
  assert.equal(completed.endedAt, 140);
  assert.equal(completed.updatedAt, 140);
  rejects(transitionSession(completed, 'Running', 150), 'terminal_state_immutable', 'state');
  rejects(transitionSession(completed, 'Completed', 139), 'invalid_transition', 'at');
  const failed = value(transitionSession(value(transitionSession(session('session-2'), 'Running', 110)), 'Failed', 120));
  assert.equal(failed.state, 'Failed');
  assert.equal(failed.endedAt, 120);
});

test('same-state requests are no-ops and invalid endpoints preserve stable from/to errors', () => {
  for (const state of VALID_SESSION_STATES) {
    const result = transitionSessionState(state, state);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.transition.action, 'noop');
  }
  for (const [from, to] of [['Running', 'Ready'], ['Ready', 'Waiting'], ['Completed', 'Failed'], ['Failed', 'Running']]) {
    const result = transitionSessionState(from, to);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.from, from);
      assert.equal(result.error.to, to);
      assert.ok(['invalid_transition', 'terminal_state_immutable'].includes(result.error.code));
    }
  }
  const unknown = transitionSessionState('running', 'Completed');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.code, 'invalid_state');
    assert.equal(unknown.error.from, 'running');
    assert.equal(unknown.error.to, 'Completed');
  }
});

test('Task association starts with no result, permits one current Session, and keeps the latest terminal reference', () => {
  const association = value(createTaskSessionAssociation('task-1'));
  assert.deepEqual(association, { taskId: 'task-1', currentSessionId: null, recentResult: null });
  const first = session('session-1');
  const linked = value(attachSessionToTask(association, first));
  assert.equal(linked.currentSessionId, 'session-1');
  const running = value(transitionSession(first, 'Running', 110));
  rejects(attachSessionToTask(linked, session('session-2'), running), 'concurrent_session', 'currentSession');
  rejects(attachSessionToTask({ ...linked, taskId: 'task-2' }, first), 'task_mismatch', 'taskId');
});

test('successful and failed terminal results have explicit semantics and timestamps', () => {
  const completed = value(transitionSession(value(transitionSession(session('session-1'), 'Running', 110)), 'Completed', 140));
  const success = value(createSessionResult(completed, { outcome: 'success', completedAt: 140, summary: 'Shipped' }));
  assert.deepEqual(success, { sessionId: 'session-1', outcome: 'success', completedAt: 140, summary: 'Shipped', error: null });
  rejects(createSessionResult(completed, { outcome: 'failure', completedAt: 140, error: 'wrong terminal outcome' }), 'invalid_result', 'outcome');
  rejects(createSessionResult(completed, { outcome: 'success', completedAt: 140, error: 'should be absent' }), 'invalid_result', 'error');
  rejects(createSessionResult(completed, { outcome: 'success', completedAt: 140, futureField: true }), 'invalid_result', 'futureField');
  const failed = value(transitionSession(value(transitionSession(session('session-2'), 'Running', 110)), 'Failed', 130));
  const failure = value(createSessionResult(failed, { outcome: 'failure', completedAt: 130, error: 'Build failed' }));
  assert.equal(failure.outcome, 'failure');
  assert.equal(failure.error, 'Build failed');
  rejects(createSessionResult(failed, { outcome: 'failure', completedAt: 130 }), 'invalid_result', 'error');
  rejects(createSessionResult(value(transitionSession(session('session-3'), 'Running', 110)), { outcome: 'success', completedAt: 110 }), 'invalid_result', 'session.state');
});

test('retry creates a distinct Session and rejects late or duplicate results', () => {
  const first = session('session-1');
  const firstDone = value(transitionSession(value(transitionSession(first, 'Running', 110)), 'Failed', 120));
  const initial = value(attachSessionToTask(value(createTaskSessionAssociation('task-1')), first));
  const withFailure = value(recordSessionResult(initial, firstDone, { outcome: 'failure', completedAt: 120, error: 'Timeout' }));
  assert.equal(withFailure.recentResult?.sessionId, 'session-1');

  const second = session('session-2');
  const retried = value(attachSessionToTask(withFailure, second, firstDone));
  assert.equal(retried.currentSessionId, 'session-2');
  assert.equal(retried.recentResult?.sessionId, 'session-1');
  rejects(recordSessionResult(retried, firstDone, { outcome: 'failure', completedAt: 121, error: 'Late old result' }), 'stale_session_result', 'sessionId');

  const secondDone = value(transitionSession(value(transitionSession(second, 'Running', 130)), 'Completed', 150));
  const success = value(recordSessionResult(retried, secondDone, { outcome: 'success', completedAt: 150 }));
  assert.equal(success.recentResult?.sessionId, 'session-2');
  rejects(recordSessionResult(success, secondDone, { outcome: 'success', completedAt: 151 }), 'result_already_recorded', 'sessionId');
});

test('two Tasks remain isolated and missing recent results stay null', () => {
  const taskA = value(attachSessionToTask(value(createTaskSessionAssociation('task-a')), session('session-a', 'task-a')));
  const taskB = value(attachSessionToTask(value(createTaskSessionAssociation('task-b')), session('session-b', 'task-b')));
  assert.equal(taskA.currentSessionId, 'session-a');
  assert.equal(taskB.currentSessionId, 'session-b');
  assert.equal(taskA.recentResult, null);
  assert.equal(taskB.recentResult, null);
  rejects(recordSessionResult(taskA, session('session-b', 'task-b'), { outcome: 'failure', completedAt: 100, error: 'wrong task' }), 'stale_session_result', 'sessionId');
});
