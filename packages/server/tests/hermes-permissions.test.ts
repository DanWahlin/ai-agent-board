import assert from 'node:assert/strict';
import test from 'node:test';
import { hermesPermissionHooks } from '../src/services/hermes-permissions.js';

test('Hermes tool auto-approval is explicit and provider-scoped', () => {
  assert.equal(hermesPermissionHooks('hermes', undefined, undefined), undefined);
  assert.equal(hermesPermissionHooks('hermes', 'false', 'true'), undefined);
  assert.equal(hermesPermissionHooks('hermes', 'true', 'false'), undefined);
  assert.equal(hermesPermissionHooks('copilot', 'true', 'true'), undefined);

  const hooks = hermesPermissionHooks('hermes', 'true', 'true');
  assert.deepEqual(hooks?.onPermissionRequest?.({ kind: 'url' }), { kind: 'approved' });
  assert.deepEqual(hooks?.onPermissionRequest?.({ kind: 'shell' }), { kind: 'approved' });
});
