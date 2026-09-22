import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentType, ProjectConfig, ProviderConfig, RoleConfig, RoleId, SettingsConfig } from './types.js';
import { errorMessage } from './utils.js';

/**
 * Agent Board persists its server-side configuration in a JSON file at a fixed
 * location (the "Agent Board home"). The clone root — where repos cloned from a
 * URL are placed — is configurable and defaults to `~/.agentboard/projects`.
 *
 * The config file deliberately lives at a fixed path (NOT inside the configurable
 * clone root) to avoid a chicken-and-egg problem: we must be able to read the
 * config before we know where the clone root is. By default the settings file
 * is `~/.agentboard/config/config.json`.
 */

const CONFIG_FILE_NAME = 'config.json';

function expandTilde(p: string): string {
  if (!p.startsWith('~')) return p;
  const rest = p.slice(p.startsWith('~/') || p.startsWith('~\\') ? 2 : 1);
  return path.join(os.homedir(), rest);
}

export function getConfigHome(): string {
  const override = process.env.AGENTBOARD_HOME?.trim();
  return override ? path.resolve(expandTilde(override)) : path.join(os.homedir(), '.agentboard', 'config');
}

function getDefaultCloneRoot(): string {
  const override = process.env.AGENTBOARD_HOME?.trim();
  return override ? path.join(getConfigHome(), 'projects') : path.join(os.homedir(), '.agentboard', 'projects');
}

function getConfigPath(): string {
  return path.join(getConfigHome(), CONFIG_FILE_NAME);
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'copilot', displayName: 'GitHub Copilot CLI', enabled: true, cliCommand: 'copilot', commandArgs: [], models: [], capabilities: ['cli', 'coding'] },
  { id: 'claude', displayName: 'Claude Code', enabled: true, cliCommand: 'claude', commandArgs: [], models: [], capabilities: ['cli', 'coding'] },
  { id: 'codex', displayName: 'Codex CLI', enabled: true, cliCommand: 'codex', commandArgs: [], models: [], capabilities: ['cli', 'coding', 'reasoning'] },
  { id: 'opencode', displayName: 'OpenCode', enabled: true, cliCommand: 'opencode', commandArgs: [], models: [], capabilities: ['cli', 'coding'] },
  { id: 'hermes', displayName: 'Hermes', enabled: true, cliCommand: process.env.HERMES_COMMAND?.trim() || 'hermes', commandArgs: ['--acp'], models: [], capabilities: ['cli', 'coding'] },
  { id: 'openclaw', displayName: 'OpenClaw', enabled: true, cliCommand: process.env.OPENCLAW_COMMAND?.trim() || 'openclaw', commandArgs: ['acp'], models: [], capabilities: ['cli', 'coding'] },
  { id: 'grok', displayName: 'Grok', enabled: true, cliCommand: 'grok', commandArgs: [], models: [], capabilities: ['cli', 'coding'] },
];

const DEFAULT_ROLES: RoleConfig[] = [
  { id: 'orchestrator', displayName: 'Orchestrator', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'high' }, instructions: 'You are the Windows Orchestrator.\n\nUse the unified handoff root C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\. Do not use a project-relative handoff or Linux paths. Clarify goal, scope, authority, route, acceptance criteria, and Human Gates. Create and maintain task, request, status, evidence, and result artifacts under the handoff root. Preserve prior attempts. Select the shortest valid route. Skip Implementer for evaluation-only or research-only work. Dispatch only required roles and validate returned artifacts before advancing. Do not modify project source, vault notes, live systems, branches, commits, or pushes. Return exact artifact paths, decisions, risks, blockers, and status.' },
  { id: 'research', displayName: 'Research', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'medium' }, instructions: 'You are the Windows Researcher.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory. Read every existing artifact before investigating so a restart resumes from checkpoints. You may freely create, update, rename, and organize any files inside that handoff directory. Do not modify project source, vault notes, branches, commits, live systems, or external services. Classify claims as FACT, HYPOTHESIS, UNKNOWN, or CONFLICT. Save evidence, notes, runbooks, results, and status to the handoff. Return BLOCKED with the precise missing evidence when authority or facts are insufficient.' },
  { id: 'implementor', displayName: 'Implementor', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'medium' }, instructions: 'You are the Windows Implementer.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory. Read the request and existing artifacts before editing. Verify task authority, branch, worktree, preconditions, acceptance criteria, and approved runbook. Modify only the assigned project/worktree scope. You may freely write any handoff artifacts. Maintain an execution ledger, run validation, inspect the diff, and record evidence, tests, deviations, rollback, and status. Stop with BLOCKED when authority or scope is insufficient. Never force-push, merge protected branches, or write vault notes.' },
  { id: 'reviewer', displayName: 'Reviewer', binding: { providerId: 'copilot', model: 'claude-opus-4-20250514', thinking: 'high' }, instructions: 'You are the Windows Reviewer.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory. Read the exact request and all existing evidence before reviewing. The subject project, worktree, live system, and vault are read-only. You may freely create, update, rename, and organize review artifacts inside the unified handoff directory. Return APPROVED, CHANGES_REQUIRED, or BLOCKED with finding ID, severity, file or step, evidence, impact, required correction, and blocking flag. Classify claims as FACT, HYPOTHESIS, UNKNOWN, or CONFLICT. Never fix the reviewed work.' },
  { id: 'knowledge', displayName: 'Knowledge', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'low' }, instructions: 'You are the Windows Knowledge Agent.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory and C:\\Users\\zhangb8\\my-obsidian-vault as the vault. Read all handoff artifacts before writing. You may freely create, update, rename, and organize files inside the handoff directory. Write durable notes only in the assigned vault scope. Search existing notes first, preserve user content, use wikilinks, and filter secrets, raw stdout, and temporary noise. Always create or update the task-history note at C:\\Users\\zhangb8\\my-obsidian-vault\\90-Agent\\Tasks\\<year>\\<task-id>.md, resolving <year> from the task date. Keep the handoff artifact at C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\knowledge.md. Read back every changed Markdown file and return UPDATE, CREATE, or NO_WRITE with actual paths and verification.' },
];

const COPILOT_ROLE_INSTRUCTIONS: Record<RoleId, string> = {
  orchestrator: 'You are the Windows Orchestrator.\n\nUse this unified handoff root for every task: C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\. Do not use project-relative handoffs or Linux paths. Clarify goal, scope, authority, route, acceptance criteria, and Human Gates. Select the shortest valid route and skip Implementer for evaluation-only or research-only work. Create and validate task, request, status, evidence, and result artifacts in the handoff root. Do not modify project source, vault notes, live systems, branches, commits, or pushes.',
  research: 'You are the Windows Researcher.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory. Read all existing artifacts before investigating so a restart resumes from checkpoints. You may freely create, update, rename, and organize files inside that directory. Do not modify project source, vault notes, branches, commits, live systems, or external services. Classify claims as FACT, HYPOTHESIS, UNKNOWN, or CONFLICT. Save evidence, notes, runbooks, results, and status to the handoff. Return BLOCKED with precise missing evidence when authority or facts are insufficient.',
  implementor: 'You are the Windows Implementer.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory. Read the request and existing artifacts before editing. Verify task authority, branch, worktree, preconditions, acceptance criteria, and approved runbook. Modify only the assigned project/worktree scope, while freely writing handoff artifacts. Maintain an execution ledger, run validation, inspect the diff, and record evidence, tests, deviations, rollback, and status. Stop with BLOCKED when authority or scope is insufficient. Never force-push, merge protected branches, or write vault notes.',
  reviewer: 'You are the Windows Reviewer.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory. Read the exact request and all existing evidence before reviewing. The subject project, worktree, live system, and vault are read-only. You may freely create, update, rename, and organize review artifacts inside the handoff directory. Return APPROVED, CHANGES_REQUIRED, or BLOCKED with finding ID, severity, affected file or step, evidence, impact, required correction, and blocking flag. Classify claims as FACT, HYPOTHESIS, UNKNOWN, or CONFLICT. Never fix the reviewed work.',
  knowledge: 'You are the Windows Knowledge Agent.\n\nUse C:\\Users\\zhangb8\\.agent-workspace\\handoffs\\<task-id>\\ as the unified handoff directory and C:\\Users\\zhangb8\\my-obsidian-vault as the vault. Read all handoff artifacts before writing. You may freely create, update, rename, and organize files inside the handoff directory. Write durable notes only in the assigned vault scope. Search existing notes first, preserve user content, use wikilinks, and filter secrets, raw stdout, and temporary noise. Always create or update 90-Agent\\Tasks\\<year>\\<task-id>.md as task history, resolving <year> from the task date. Read back every changed Markdown file and return UPDATE, CREATE, or NO_WRITE with actual paths and verification.',
};

function cloneProviders(): ProviderConfig[] {
  return DEFAULT_PROVIDERS.map(provider => ({ ...provider, commandArgs: [...provider.commandArgs], models: [...provider.models], capabilities: [...provider.capabilities] }));
}

function cloneRoles(): RoleConfig[] {
  return DEFAULT_ROLES.map(role => ({
    ...role,
    binding: { ...role.binding },
    providerInstructions: { codex: role.instructions, copilot: COPILOT_ROLE_INSTRUCTIONS[role.id] },
  }));
}

function defaultConfig(): SettingsConfig {
  return { cloneRoot: getDefaultCloneRoot(), providers: cloneProviders(), roles: cloneRoles() };
}

let cached: SettingsConfig | null = null;

function configuredProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return cloneProviders();
  const defaults = new Map(DEFAULT_PROVIDERS.map(provider => [provider.id, provider]));
  const parsed = raw.flatMap((item): ProviderConfig[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<ProviderConfig>;
    const base = typeof candidate.id === 'string' ? defaults.get(candidate.id as AgentType) : undefined;
    if (!base || typeof candidate.displayName !== 'string' || typeof candidate.cliCommand !== 'string'
      || typeof candidate.enabled !== 'boolean' || !Array.isArray(candidate.commandArgs)
      || (candidate.defaultModel !== undefined && typeof candidate.defaultModel !== 'string')
      || !Array.isArray(candidate.models) || !Array.isArray(candidate.capabilities)) return [];
    if (![...candidate.commandArgs, ...candidate.models, ...candidate.capabilities].every(value => typeof value === 'string')) return [];
    return [{
      id: base.id,
      displayName: candidate.displayName,
      enabled: candidate.enabled,
      cliCommand: candidate.cliCommand,
      commandArgs: [...candidate.commandArgs],
      models: [...candidate.models],
      defaultModel: typeof candidate.defaultModel === 'string' && candidate.defaultModel.trim() ? candidate.defaultModel.trim() : base.defaultModel,
      capabilities: [...candidate.capabilities],
    }];
  });
  return parsed.length === DEFAULT_PROVIDERS.length ? parsed : cloneProviders();
}

function configuredRoles(raw: unknown): RoleConfig[] {
  if (!Array.isArray(raw)) return cloneRoles();
  const defaults = new Map(cloneRoles().map(role => [role.id, role]));
  const parsed = raw.flatMap((item): RoleConfig[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<RoleConfig>;
    const base = typeof candidate.id === 'string' ? defaults.get(candidate.id as RoleConfig['id']) : undefined;
    const binding = candidate.binding;
    if (!base || typeof candidate.displayName !== 'string' || typeof candidate.instructions !== 'string'
      || !binding || typeof binding !== 'object' || typeof binding.providerId !== 'string'
      || typeof binding.model !== 'string' || (binding.thinking !== 'low' && binding.thinking !== 'medium' && binding.thinking !== 'high')) return [];
    const providerInstructions = candidate.providerInstructions && typeof candidate.providerInstructions === 'object'
      ? Object.fromEntries(Object.entries(candidate.providerInstructions).filter(([key, value]) =>
        typeof key === 'string' && typeof value === 'string' && value.trim(),
      ).map(([key, value]) => [key, (value as string).trim()])) as Partial<Record<AgentType, string>>
      : { ...base.providerInstructions, [binding.providerId as AgentType]: candidate.instructions.trim() };
    return [{
      id: base.id,
      displayName: candidate.displayName,
      instructions: candidate.instructions,
      binding: { providerId: binding.providerId as AgentType, model: binding.model, thinking: binding.thinking },
      providerInstructions,
    }];
  });
  return parsed.length === DEFAULT_ROLES.length ? parsed : cloneRoles();
}

/** Atomically write the config file (temp file + rename) to avoid corruption. */
function writeConfig(config: SettingsConfig): void {
  const home = getConfigHome();
  fs.mkdirSync(home, { recursive: true });
  const target = getConfigPath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Load (and if necessary create) the Agent Board config. Ensures the home
 * directory, the config file, and the clone root directory all exist.
 */
export function loadConfig(): SettingsConfig {
  if (cached) return cached;

  const home = getConfigHome();
  fs.mkdirSync(home, { recursive: true });

  const configPath = getConfigPath();
  let config = defaultConfig();
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<SettingsConfig>;
      if (raw && typeof raw.cloneRoot === 'string' && raw.cloneRoot.trim()) {
        config = {
          cloneRoot: path.resolve(expandTilde(raw.cloneRoot.trim())),
          providers: configuredProviders(raw.providers),
          roles: configuredRoles(raw.roles),
        };
      } else {
        writeConfig(config);
      }
    } catch (err) {
      console.warn(`[config] failed to read ${configPath}, using defaults: ${errorMessage(err)}`);
      writeConfig(config);
    }
  } else {
    writeConfig(config);
  }

  fs.mkdirSync(config.cloneRoot, { recursive: true });
  cached = config;
  return config;
}

export function getConfig(): SettingsConfig {
  return cached ?? loadConfig();
}

export function getCloneRoot(): string {
  return getConfig().cloneRoot;
}

/**
 * Update the clone root. The new path is expanded/resolved, created on disk, and
 * persisted to the config file. Returns the updated config.
 */
export function setCloneRoot(cloneRoot: string): ProjectConfig {
  const trimmed = cloneRoot.trim();
  if (!trimmed) throw new Error('cloneRoot must be a non-empty string');
  const resolved = path.resolve(expandTilde(trimmed));
  if (!path.isAbsolute(resolved)) throw new Error('cloneRoot must be an absolute path');
  fs.mkdirSync(resolved, { recursive: true });
  const next: SettingsConfig = { ...getConfig(), cloneRoot: resolved };
  writeConfig(next);
  cached = next;
  return next;
}

export function setSettings(settings: SettingsConfig): SettingsConfig {
  const cloneRoot = settings.cloneRoot.trim();
  if (!cloneRoot) throw new Error('cloneRoot must be a non-empty string');
  const next: SettingsConfig = { ...settings, cloneRoot: path.resolve(expandTilde(cloneRoot)) };
  fs.mkdirSync(next.cloneRoot, { recursive: true });
  writeConfig(next);
  cached = next;
  return next;
}

export function setProviderModels(providerId: AgentType, models: string[], defaultModel?: string): SettingsConfig {
  const current = getConfig();
  const provider = current.providers.find(item => item.id === providerId);
  if (!provider) return current;
  const nextModels = [...new Set(models.map(model => model.trim()).filter(Boolean))];
  const nextDefault = defaultModel && nextModels.includes(defaultModel.trim())
    ? defaultModel.trim()
    : provider.defaultModel && nextModels.includes(provider.defaultModel)
      ? provider.defaultModel
      : nextModels[0];
  const next: SettingsConfig = {
    ...current,
    providers: current.providers.map(item => item.id === providerId
      ? { ...item, models: nextModels, defaultModel: nextDefault }
      : item),
    roles: current.roles.map(role => role.binding.providerId === providerId && nextDefault && !nextModels.includes(role.binding.model)
      ? { ...role, binding: { ...role.binding, model: nextDefault } }
      : role),
  };
  if (provider.models.join('\0') === nextModels.join('\0') && provider.defaultModel === nextDefault) return current;
  writeConfig(next);
  cached = next;
  return next;
}
