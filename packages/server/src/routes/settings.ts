import { Router, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentManager } from '../services/agent-manager.js';
import type { ProviderConfig, RoleBindingOverride, RoleConfig, SettingsConfig, SettingsResponse } from '../types.js';
import { getConfig, setProviderModels, setSettings } from '../config.js';
import { parseSettingsConfig, resolveRoleExecution } from '../services/settings-validation.js';
import { listProviderModels } from '../services/provider-models.js';
import { isBuiltInRoleId, isValidAgentType } from '@ai-agent-board/shared/constants.js';

const execFileAsync = promisify(execFile);

async function settingsResponse(agentManager: AgentManager): Promise<SettingsResponse> {
  let settings = getConfig();
  const availability = new Map(agentManager.getAvailableAgents().map(agent => [agent.name, agent]));
  for (const provider of settings.providers) {
    if (provider.id === 'codex' && (!provider.enabled || !availability.get(provider.id)?.available)) {
      settings = setProviderModels(provider.id, []);
      continue;
    }
    const discovered = await listProviderModels(provider);
    settings = setProviderModels(provider.id, discovered.models, discovered.defaultModel);
  }
  settings = getConfig();
  return {
    ...settings,
    providerValidation: settings.providers.map((provider) => {
      const agent = availability.get(provider.id);
      return {
        ...provider,
        available: Boolean(agent?.available) && provider.enabled,
        version: agent?.version,
        reason: !provider.enabled ? 'Disabled in Settings' : agent?.reason,
      };
    }),
  };
}

function replaceProvider(settings: SettingsConfig, provider: ProviderConfig): SettingsConfig {
  return { ...settings, providers: settings.providers.map(item => item.id === provider.id ? provider : item) };
}

function replaceRole(settings: SettingsConfig, role: RoleConfig): SettingsConfig {
  return { ...settings, roles: settings.roles.map(item => item.id === role.id ? role : item) };
}

export function createSettingsRouter(agentManager: AgentManager): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => res.json(await settingsResponse(agentManager)));

  router.put('/providers/:id', async (req: Request, res: Response) => {
    if (!isValidAgentType(req.params.id)) {
      res.status(400).json({ error: 'unknown provider id' }); return;
    }
    const candidate = { ...req.body, id: req.params.id } as ProviderConfig;
    const parsed = parseSettingsConfig(replaceProvider(getConfig(), candidate));
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed }); return;
    }
    setSettings(parsed);
    res.json(await settingsResponse(agentManager));
  });

  router.post('/providers/:id/test', async (req: Request, res: Response) => {
    if (!isValidAgentType(req.params.id)) {
      res.status(400).json({ available: false, error: 'unknown provider id' }); return;
    }
    const provider = getConfig().providers.find(item => item.id === req.params.id);
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : provider?.defaultModel;
    if (!provider || !model) {
      res.status(400).json({ available: false, error: 'provider model is not configured' }); return;
    }
    if (!provider.enabled) {
      res.status(400).json({ available: false, model, error: 'provider is disabled in Settings' }); return;
    }
    if (provider.models.length > 0 && !provider.models.includes(model)) {
      res.status(400).json({ available: false, model, error: `model ${model} is not configured for ${provider.id}` }); return;
    }
    try {
      const result = await execFileAsync(provider.cliCommand, [...provider.commandArgs, '--version'], {
        timeout: 10_000,
        windowsHide: true,
        env: process.env,
      });
      const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split(/\r?\n/)[0] || undefined;
      res.json({ available: true, model, version, message: `${provider.displayName} CLI is reachable and model is configured.` });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      res.json({ available: false, model, error: `Unable to reach ${provider.displayName} CLI: ${detail}` });
    }
  });

  router.put('/roles/:id', async (req: Request, res: Response) => {
    if (!isBuiltInRoleId(req.params.id)) {
      res.status(400).json({ error: 'unknown role id' }); return;
    }
    const candidate = { ...req.body, id: req.params.id } as RoleConfig;
    const parsed = parseSettingsConfig(replaceRole(getConfig(), candidate));
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed }); return;
    }
    setSettings(parsed);
    res.json(await settingsResponse(agentManager));
  });

  router.post('/roles/:id/resolve', (req: Request, res: Response) => {
    if (!isBuiltInRoleId(req.params.id)) {
      res.status(400).json({ error: 'unknown role id' }); return;
    }
    const snapshot = resolveRoleExecution(getConfig(), req.params.id, (req.body ?? {}) as RoleBindingOverride);
    if (typeof snapshot === 'string') {
      res.status(400).json({ error: snapshot }); return;
    }
    res.json(snapshot);
  });

  return router;
}
