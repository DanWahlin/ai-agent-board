import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { isAllowedWebSocketRequest, isLoopbackAddress, normalizeHostname, parseList } from '../src/network-policy.js';

function request(host: string | undefined, origin?: string): IncomingMessage {
  return { headers: { host, origin } } as IncomingMessage;
}

test('parseList trims values and removes blanks', () => {
  assert.deepEqual(parseList(' localhost, kanban.example ,,', 'fallback'), ['localhost', 'kanban.example']);
  assert.deepEqual(parseList(undefined, 'localhost,127.0.0.1'), ['localhost', '127.0.0.1']);
});

test('normalizeHostname handles ports and IPv6', () => {
  assert.equal(normalizeHostname('Kanban.Example:8081'), 'kanban.example');
  assert.equal(normalizeHostname('[::1]:8081'), '[::1]');
  assert.equal(normalizeHostname(undefined), undefined);
});

test('WebSocket policy rejects hostile hosts and origins', () => {
  const hosts = ['localhost', '127.0.0.1', 'kanban.example'];
  const origins = ['https://kanban.example', 'http://localhost:8081'];
  assert.equal(isAllowedWebSocketRequest(request('kanban.example'), hosts, origins), true);
  assert.equal(isAllowedWebSocketRequest(request('kanban.example', 'https://kanban.example'), hosts, origins), true);
  assert.equal(isAllowedWebSocketRequest(request('attacker.example', 'https://kanban.example'), hosts, origins), false);
  assert.equal(isAllowedWebSocketRequest(request('kanban.example', 'https://attacker.example'), hosts, origins), false);
  assert.equal(isAllowedWebSocketRequest(request(undefined), hosts, origins), false);
});

test('loopback classification uses the effective bound address', () => {
  assert.equal(isLoopbackAddress({ address: '127.0.0.2', family: 'IPv4', port: 8080 }), true);
  assert.equal(isLoopbackAddress({ address: '::1', family: 'IPv6', port: 8080 }), true);
  assert.equal(isLoopbackAddress({ address: '0.0.0.0', family: 'IPv4', port: 8080 }), false);
  assert.equal(isLoopbackAddress({ address: '192.0.2.10', family: 'IPv4', port: 8080 }), false);
});
