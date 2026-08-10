import assert from 'node:assert/strict';
import test from 'node:test';

async function load() { return import(`../src/middleware/auth.js?test=${Date.now()}-${Math.random()}`); }

test('legacy API_KEY remains accepted', async()=>{ process.env.API_KEY='legacy-secret'; delete process.env.SERVICE_TOKENS; const {authenticateToken}=await load(); assert.equal(authenticateToken('legacy-secret').legacy,true); delete process.env.API_KEY; });
test('hashed service token receives only configured safe scopes', async()=>{ delete process.env.API_KEY; process.env.SERVICE_TOKENS=JSON.stringify([{sha256:'2f5b78396adc3b6cb3d9c5ff6a5e428e1f53caf69e6e40e3caa9155c898f56ae',scopes:['projects:read','orchestrations:create','projects:write','tasks:delete']}]); const {authenticateToken,isValidToken}=await load(); const auth=authenticateToken('service-secret'); assert.equal(auth.authenticated,true); assert.deepEqual(auth.scopes,['projects:read','orchestrations:create']); assert.equal(isValidToken('service-secret'),false); delete process.env.SERVICE_TOKENS; });
