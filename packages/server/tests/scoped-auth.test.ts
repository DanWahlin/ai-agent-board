import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import type { Request } from 'express';
import { authMiddleware } from '../src/middleware/auth.js';

async function load() { return import(`../src/middleware/auth.js?test=${Date.now()}-${Math.random()}`); }

async function withAuthApi(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api', authMiddleware);
  app.use('/api', (req, res) => res.json({ path: req.path, method: req.method }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}/api`); }
  finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

test('legacy API_KEY remains accepted', async () => {
  process.env.API_KEY = 'legacy-secret';
  delete process.env.SERVICE_TOKENS;
  const { authenticateToken } = await load();
  assert.equal(authenticateToken('legacy-secret').legacy, true);
  delete process.env.API_KEY;
});

test('hashed service token receives only configured safe scopes', async () => {
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([{ sha256: '2f5b78396adc3b6cb3d9c5ff6a5e428e1f53caf69e6e40e3caa9155c898f56ae', scopes: ['projects:read', 'orchestrations:create', 'projects:write', 'tasks:delete'] }]);
  const { authenticateToken, isValidToken } = await load();
  const auth = authenticateToken('service-secret');
  assert.equal(auth.authenticated, true);
  assert.deepEqual(auth.scopes, ['projects:read', 'orchestrations:create']);
  assert.equal(isValidToken('service-secret'), false);
  delete process.env.SERVICE_TOKENS;
});

test('scope mapping covers allowlisted project, agent, and relationship reads and writes', async () => {
  const { requiredScope } = await load();
  const request = (path: string, method: string) => ({ path, method }) as Request;
  assert.equal(requiredScope(request('/projects', 'GET')), 'projects:read');
  assert.equal(requiredScope(request('/projects/a', 'GET')), 'projects:read');
  assert.equal(requiredScope(request('/projects/config', 'GET')), undefined);
  assert.equal(requiredScope(request('/agents', 'GET')), 'agents:read');
  assert.equal(requiredScope(request('/tasks/a/relationships', 'GET')), 'tasks:relationships');
  assert.equal(requiredScope(request('/tasks/a/relationships', 'POST')), 'tasks:relationships');
  assert.equal(requiredScope(request('/tasks/a/relationships/b', 'DELETE')), 'tasks:relationships');
});

test('middleware enforces exact service scopes while preserving tokenless browser reads', async () => {
  const oldApiKey = process.env.API_KEY;
  const oldTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([
    { token: 'projects-token', scopes: ['projects:read'] },
    { token: 'agents-token', scopes: ['agents:read'] },
    { token: 'relations-token', scopes: ['tasks:relationships'] },
  ]);
  try {
    await withAuthApi(async (base) => {
      // Ordinary tokenless browser reads remain available in SERVICE_TOKENS-only mode.
      assert.equal((await fetch(`${base}/projects`)).status, 200);
      assert.equal((await fetch(`${base}/agents`)).status, 200);
      assert.equal((await fetch(`${base}/tasks/t/relationships`)).status, 200);

      assert.equal((await fetch(`${base}/projects`, { headers: bearer('projects-token') })).status, 200);
      assert.equal((await fetch(`${base}/projects/exact-id`, { headers: bearer('projects-token') })).status, 200);
      assert.equal((await fetch(`${base}/agents`, { headers: bearer('agents-token') })).status, 200);
      assert.equal((await fetch(`${base}/tasks/t/relationships`, { headers: bearer('relations-token') })).status, 200);
      assert.equal((await fetch(`${base}/tasks/t/relationships`, { method: 'POST', headers: bearer('relations-token') })).status, 200);
      assert.equal((await fetch(`${base}/tasks/t/relationships/r`, { method: 'DELETE', headers: bearer('relations-token') })).status, 200);

      assert.equal((await fetch(`${base}/projects`, { headers: bearer('agents-token') })).status, 403);
      assert.equal((await fetch(`${base}/agents`, { headers: bearer('projects-token') })).status, 403);
      assert.equal((await fetch(`${base}/tasks/t/relationships`, { headers: bearer('projects-token') })).status, 403);
      assert.equal((await fetch(`${base}/projects`, { headers: bearer('invalid') })).status, 401);
      // A service token cannot fall through onto a non-allowlisted mutation.
      assert.equal((await fetch(`${base}/projects`, { method: 'POST', headers: bearer('projects-token') })).status, 403);
      // Scoped mutations still require a credential.
      assert.equal((await fetch(`${base}/tasks/t/relationships`, { method: 'POST' })).status, 401);
    });
  } finally {
    if (oldApiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = oldApiKey;
    if (oldTokens === undefined) delete process.env.SERVICE_TOKENS; else process.env.SERVICE_TOKENS = oldTokens;
  }
});

test('middleware accepts scoped reads alongside API_KEY but not absent or wrong-scoped credentials', async () => {
  const oldApiKey = process.env.API_KEY;
  const oldTokens = process.env.SERVICE_TOKENS;
  process.env.API_KEY = 'legacy';
  process.env.SERVICE_TOKENS = JSON.stringify([
    { token: 'projects-token', scopes: ['projects:read'] },
    { token: 'agents-token', scopes: ['agents:read'] },
  ]);
  try {
    await withAuthApi(async (base) => {
      assert.equal((await fetch(`${base}/projects`, { headers: bearer('projects-token') })).status, 200);
      assert.equal((await fetch(`${base}/projects/id`, { headers: bearer('projects-token') })).status, 200);
      assert.equal((await fetch(`${base}/agents`, { headers: bearer('agents-token') })).status, 200);
      assert.equal((await fetch(`${base}/projects`)).status, 401);
      assert.equal((await fetch(`${base}/projects`, { headers: bearer('agents-token') })).status, 403);
      assert.equal((await fetch(`${base}/projects`, { headers: bearer('legacy') })).status, 200);
    });
  } finally {
    if (oldApiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = oldApiKey;
    if (oldTokens === undefined) delete process.env.SERVICE_TOKENS; else process.env.SERVICE_TOKENS = oldTokens;
  }
});
