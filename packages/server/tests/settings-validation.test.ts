import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettingsConfig, resolveRoleExecution } from '../src/services/settings-validation.js';

const providerIds = ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok'] as const;

function settings(overrides: Record<string, unknown> = {}) {
  const providers = providerIds.map(id => ({
    id,
    displayName: id,
    enabled: true,
    cliCommand: id,
    commandArgs: [],
    models: id === 'codex' ? ['gpt-5.2-codex'] : id === 'copilot' ? ['claude-opus-4-20250514'] : [],
    capabilities: ['cli'],
  }));
  const roles = ['orchestrator', 'research', 'implementor', 'reviewer', 'knowledge'].map(id => ({
    id,
    displayName: id,
    binding: { providerId: id === 'reviewer' ? 'copilot' : 'codex', model: id === 'reviewer' ? 'claude-opus-4-20250514' : 'gpt-5.2-codex', thinking: 'medium' },
    instructions: `Instructions for ${id}`,
  }));
  return { cloneRoot: 'C:/agentboard/projects', providers, roles, ...overrides };
}

test('accepts Codex and Copilot CLI provider configuration and role bindings', () => {
  const parsed = parseSettingsConfig(settings());
  assert.notEqual(typeof parsed, 'string');
  if (typeof parsed === 'string') return;
  assert.equal(parsed.providers.find(provider => provider.id === 'codex')?.cliCommand, 'codex');
  assert.equal(parsed.providers.find(provider => provider.id === 'copilot')?.cliCommand, 'copilot');
  assert.equal(parsed.roles.find(role => role.id === 'reviewer')?.binding.providerId, 'copilot');
});

test('rejects a role model that is not offered by its provider', () => {
  const value = settings();
  const role = value.roles.find(item => item.id === 'orchestrator')!;
  role.binding.model = 'not-a-codex-model';
  assert.match(parseSettingsConfig(value) as string, /not available for provider codex/);
});

test('rejects disabling a provider that is still bound by a role', () => {
  const value = settings();
  value.providers.find(item => item.id === 'codex')!.enabled = false;
  assert.match(parseSettingsConfig(value) as string, /provider codex is disabled/);
});

test('runtime Role override returns an immutable snapshot without changing global settings', () => {
  const value = parseSettingsConfig(settings());
  assert.notEqual(typeof value, 'string');
  if (typeof value === 'string') return;
  const snapshot = resolveRoleExecution(value, 'orchestrator', { providerId: 'copilot', model: 'claude-opus-4-20250514', thinking: 'low' });
  assert.notEqual(typeof snapshot, 'string');
  if (typeof snapshot === 'string') return;
  assert.deepEqual(snapshot.binding, { providerId: 'copilot', model: 'claude-opus-4-20250514', thinking: 'low' });
  assert.equal(value.roles.find(role => role.id === 'orchestrator')?.binding.providerId, 'codex');
});

test('resolves embedded instructions for the selected provider without reading external role files', () => {
  const value = parseSettingsConfig(settings({
    roles: settings().roles.map(role => role.id === 'reviewer' ? {
      ...role,
      providerInstructions: {
        codex: 'Codex reviewer instruction',
        copilot: 'Copilot reviewer instruction',
      },
    } : role),
  }));
  assert.notEqual(typeof value, 'string');
  if (typeof value === 'string') return;
  const codex = resolveRoleExecution(value, 'reviewer', { providerId: 'codex', model: 'gpt-5.2-codex' });
  const copilot = resolveRoleExecution(value, 'reviewer');
  assert.notEqual(typeof codex, 'string');
  assert.notEqual(typeof copilot, 'string');
  if (typeof codex === 'string' || typeof copilot === 'string') return;
  assert.equal(codex.instructions, 'Codex reviewer instruction');
  assert.equal(copilot.instructions, 'Copilot reviewer instruction');
});
