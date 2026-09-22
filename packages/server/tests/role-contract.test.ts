import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRole, updateRole, validateCreateRole, validateUpdateRole,
  snapshotRoleExecution, VALID_AGENT_TYPES,
} from '@ai-agent-board/shared/constants.js';
import type { RoleContractResult, Role } from '@ai-agent-board/shared/types.js';

const input = () => ({
  name: ' Reviewer ',
  responsibility: 'Review changes; do not approve your own work.',
  instructions: '  Read the diff.\nRun focused checks.\n',
  execution: { provider: 'codex', model: ' custom/model ' },
});

function value<T>(result: RoleContractResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected success');
  return result.value;
}

function rejects(result: RoleContractResult<unknown>, path: string, code: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected validation failure');
  assert.ok(result.errors.some(error => error.path === path && error.code === code), JSON.stringify(result.errors));
}

test('creates a role with caller-owned identity independent of display name and provider', () => {
  const role = value(createRole('role-1', input()));
  assert.equal(role.id, 'role-1');
  assert.equal(role.name, 'Reviewer');
  assert.equal(role.execution.provider, 'codex');
  assert.equal(role.execution.model, 'custom/model');
  assert.equal(role.instructions, input().instructions);
  assert.equal(role.responsibility, input().responsibility);
  assert.equal(value(updateRole(role, { name: 'Copilot' })).id, role.id);
  rejects(updateRole(role, { id: 'role-2' }), 'id', 'unknown_field');
  rejects(createRole(' ', input()), 'id', 'invalid_type');
  rejects(createRole(' role-1', input()), 'id', 'invalid_type');
});

test('preserves every existing provider and accepts model identifiers without an invented catalog', () => {
  assert.deepEqual(VALID_AGENT_TYPES, ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok']);
  for (const provider of VALID_AGENT_TYPES) {
    const role = value(createRole('role-1', { ...input(), execution: { provider } }));
    assert.deepEqual(role.execution, { provider, model: null });
    assert.equal(value(createRole('role-1', { ...input(), execution: { provider, model: 'future/model-v99' } })).execution.model, 'future/model-v99');
  }
});

test('create requires the role fields and provider; optional model defaults to null', () => {
  for (const field of ['name', 'responsibility', 'instructions', 'execution']) {
    const candidate: Record<string, unknown> = input();
    delete candidate[field];
    rejects(validateCreateRole(candidate), field, 'required');
  }
  rejects(validateCreateRole({ ...input(), execution: {} }), 'execution.provider', 'required');
  assert.equal(value(validateCreateRole({ ...input(), execution: { provider: 'codex' } })).execution.model, null);
  assert.equal(value(validateCreateRole({ ...input(), execution: { provider: 'codex', model: null } })).execution.model, null);
});

test('create and update reject invalid objects, null, undefined, blanks and unknown write fields', () => {
  for (const validate of [validateCreateRole, validateUpdateRole]) {
    for (const invalid of [null, undefined, [], 'role', 1, new Date()]) {
      rejects(validate(invalid), '', 'invalid_type');
    }
    for (const field of ['name', 'responsibility', 'instructions']) {
      for (const invalid of [null, undefined, 3, false, []]) {
        rejects(validate({ ...input(), [field]: invalid }), field, 'invalid_type');
      }
      rejects(validate({ ...input(), [field]: ' \n\t' }), field, 'blank');
    }
    for (const invalid of [null, undefined, [], 'codex']) {
      rejects(validate({ ...input(), execution: invalid }), 'execution', 'invalid_type');
    }
    for (const provider of ['Codex', 'Reviewer', 'unknown', '', null, undefined, 1]) {
      rejects(validate({ ...input(), execution: { provider } }), 'execution.provider', 'unknown_provider');
    }
    for (const model of [undefined, 1, false, {}, []]) {
      rejects(validate({ ...input(), execution: { provider: 'codex', model } }), 'execution.model', 'invalid_type');
    }
    rejects(validate({ ...input(), execution: { provider: 'codex', model: ' ' } }), 'execution.model', 'blank');
    rejects(validate({ ...input(), agentType: 'codex' }), 'agentType', 'unknown_field');
    rejects(validate({ ...input(), execution: { provider: 'codex', command: 'run' } }), 'execution.command', 'unknown_field');
    rejects(validate(JSON.parse('{"__proto__":{},"name":"x"}')), '__proto__', 'unknown_field');
  }
});

test('patches preserve omitted fields and input objects, including nested execution selections', () => {
  const role = value(createRole('role-1', input()));
  const before = structuredClone(role);
  assert.deepEqual(value(updateRole(role, {})), role);
  assert.deepEqual(value(updateRole(role, { execution: {} })), role);
  const renamed = value(updateRole(role, { name: 'New name' }));
  assert.deepEqual(renamed, { ...role, name: 'New name' });
  assert.notEqual(renamed.execution, role.execution);
  assert.deepEqual(role, before);
  assert.deepEqual(value(validateUpdateRole({ name: ' X ' })), { name: 'X' });
  assert.deepEqual(value(validateUpdateRole({ execution: {} })), { execution: {} });
  assert.equal(value(updateRole(role, { execution: { model: null } })).execution.model, null);
  assert.equal(value(updateRole(role, { execution: { model: 'next' } })).execution.provider, 'codex');
});

test('provider changes reset model selection unless an explicit model accompanies the change', () => {
  const role = value(createRole('role-1', input()));
  assert.deepEqual(value(updateRole(role, { execution: { provider: 'claude' } })).execution, { provider: 'claude', model: null });
  assert.deepEqual(value(updateRole(role, { execution: { provider: 'claude', model: 'custom/model' } })).execution, { provider: 'claude', model: 'custom/model' });
  assert.deepEqual(value(updateRole(role, { execution: { provider: 'codex' } })).execution, role.execution);
  const before = structuredClone(role);
  rejects(updateRole(role, { name: 'Changed', execution: { provider: 'unsupported' } }), 'execution.provider', 'unknown_provider');
  assert.deepEqual(role, before);
});

test('partial edits retain unknown read-side data but reject echoing it into write commands', () => {
  const role = {
    ...value(createRole('role-1', input())),
    futureLabel: 'retained',
    execution: { provider: 'codex' as const, model: null, futureOption: true },
  };
  assert.deepEqual(value(updateRole(role, { name: 'Edited' })), { ...role, name: 'Edited' });
  rejects(validateUpdateRole(role), 'futureLabel', 'unknown_field');
  rejects(validateUpdateRole({ execution: role.execution }), 'execution.futureOption', 'unknown_field');
});

test('execution snapshots survive role edits, source mutation and JSON round trips', () => {
  const role: Role = value(createRole('role-1', input()));
  const snapshot = snapshotRoleExecution(role);
  const captured = JSON.stringify(snapshot);
  const edited = value(updateRole(role, { instructions: 'New instructions', execution: { provider: 'claude' } }));
  assert.equal(edited.instructions, 'New instructions');
  role.instructions = 'Direct mutation';
  role.execution.model = 'another-model';
  assert.equal(JSON.stringify(snapshot), captured);
  assert.deepEqual(JSON.parse(captured), {
    roleId: 'role-1', name: 'Reviewer', responsibility: input().responsibility,
    instructions: input().instructions, execution: { provider: 'codex', model: 'custom/model' },
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.execution));
  assert.throws(() => Object.assign(snapshot.execution, { model: 'mutated' }), TypeError);
});
