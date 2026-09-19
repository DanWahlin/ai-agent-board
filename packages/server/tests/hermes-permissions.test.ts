import assert from 'node:assert/strict';
import test from 'node:test';
import { hermesPermissionHooks } from '../src/services/hermes-permissions.js';

test('Hermes tool auto-approval is explicit and provider-scoped', () => {
  assert.equal(hermesPermissionHooks('hermes', 'coding', undefined, undefined, undefined), undefined);
  assert.equal(hermesPermissionHooks('hermes', 'coding', 'false', 'true', undefined), undefined);
  assert.equal(hermesPermissionHooks('hermes', 'coding', 'true', 'false', undefined), undefined);
  assert.equal(hermesPermissionHooks('copilot', 'coding', 'true', 'true', undefined), undefined);

  const hooks = hermesPermissionHooks('hermes', 'coding', 'true', 'true', undefined);
  assert.deepEqual(hooks?.onPermissionRequest?.({ kind: 'url' }), { kind: 'approved' });
  assert.deepEqual(hooks?.onPermissionRequest?.({ kind: 'shell' }), { kind: 'approved' });
});

test('agent-default Hermes approval uses only its dedicated flag', () => {
  assert.equal(hermesPermissionHooks('hermes', 'agent-default', 'true', 'true', undefined), undefined);
  assert.equal(hermesPermissionHooks('hermes', 'agent-default', undefined, undefined, 'false'), undefined);
  const hooks = hermesPermissionHooks('hermes', 'agent-default', undefined, undefined, 'true');
  assert.deepEqual(hooks?.onPermissionRequest?.({ kind: 'shell' }), { kind: 'approved' });
  assert.equal(hermesPermissionHooks('copilot', 'agent-default', undefined, undefined, 'true'), undefined);
});
