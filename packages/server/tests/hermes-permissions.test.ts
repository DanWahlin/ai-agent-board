import assert from 'node:assert/strict';
import test from 'node:test';
import { hermesPermissionHooks } from '../src/services/hermes-permissions.js';

test('Hermes tool auto-approval is explicit and provider-scoped', () => {
  assert.equal(hermesPermissionHooks('hermes', undefined), undefined);
  assert.equal(hermesPermissionHooks('hermes', 'false'), undefined);
  assert.equal(hermesPermissionHooks('copilot', 'true'), undefined);

  const hooks = hermesPermissionHooks('hermes', 'true');
  assert.deepEqual(hooks?.onPermissionRequest?.({ kind: 'url' }), { kind: 'approved' });
  assert.deepEqual(hooks?.onPermissionRequest?.({ kind: 'shell' }), { kind: 'approved' });
});
