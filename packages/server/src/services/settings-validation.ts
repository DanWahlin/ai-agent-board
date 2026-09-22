import type { ProviderConfig, RoleBindingOverride, RoleConfig, RoleExecutionSnapshot, RoleId, SettingsConfig } from '../types.js';
import { BUILT_IN_ROLE_IDS, VALID_AGENT_TYPES, isBuiltInRoleId, isValidAgentType, isValidThinkingEffort } from '@ai-agent-board/shared/constants.js';

function uniqueNonEmptyStrings(value: unknown, field: string): string[] | string {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return `${field} must be an array of strings`;
  const normalized = value.map(item => item.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) return `${field} must not contain duplicate values`;
  return normalized;
}

function parseProvider(value: unknown): ProviderConfig | string {
  if (!value || typeof value !== 'object') return 'provider must be an object';
  const provider = value as Partial<ProviderConfig>;
  if (!isValidAgentType(provider.id)) return `provider id must be one of ${VALID_AGENT_TYPES.join(', ')}`;
  if (typeof provider.displayName !== 'string' || !provider.displayName.trim()) return 'provider displayName is required';
  if (typeof provider.enabled !== 'boolean') return 'provider enabled must be a boolean';
  if (typeof provider.cliCommand !== 'string' || !provider.cliCommand.trim()) return 'provider cliCommand is required';
  const commandArgs = uniqueNonEmptyStrings(provider.commandArgs, 'provider commandArgs');
  const models = uniqueNonEmptyStrings(provider.models, 'provider models');
  const capabilities = uniqueNonEmptyStrings(provider.capabilities, 'provider capabilities');
  if (typeof commandArgs === 'string' || typeof models === 'string' || typeof capabilities === 'string') {
    return [commandArgs, models, capabilities].find(item => typeof item === 'string') as string;
  }
  if (provider.defaultModel !== undefined && (typeof provider.defaultModel !== 'string' || !provider.defaultModel.trim())) return 'provider defaultModel must be a non-empty string';
  if (provider.defaultModel && models.length > 0 && !models.includes(provider.defaultModel.trim())) return `provider defaultModel ${provider.defaultModel.trim()} is not available in provider models`;
  return {
    id: provider.id,
    displayName: provider.displayName.trim(),
    enabled: provider.enabled,
    cliCommand: provider.cliCommand.trim(),
    commandArgs,
    models,
    defaultModel: provider.defaultModel?.trim() || models[0],
    capabilities,
  };
}

function parseRole(value: unknown, providers: ProviderConfig[]): RoleConfig | string {
  if (!value || typeof value !== 'object') return 'role must be an object';
  const role = value as Partial<RoleConfig>;
  if (!isBuiltInRoleId(role.id)) return `role id must be one of ${BUILT_IN_ROLE_IDS.join(', ')}`;
  if (typeof role.displayName !== 'string' || !role.displayName.trim()) return 'role displayName is required';
  if (typeof role.instructions !== 'string' || !role.instructions.trim()) return 'role instructions are required';
  if (role.instructions.length > 20_000) return 'role instructions must be at most 20000 characters';
  const binding = role.binding;
  if (!binding || typeof binding !== 'object' || !isValidAgentType(binding.providerId)
    || typeof binding.model !== 'string' || !binding.model.trim() || !isValidThinkingEffort(binding.thinking)) {
    return 'role binding requires a providerId, model, and valid thinking effort';
  }
  const provider = providers.find(item => item.id === binding.providerId);
  if (!provider) return `role binding provider ${binding.providerId} is not configured`;
  if (!provider.enabled) return `role binding provider ${binding.providerId} is disabled`;
  if (provider.models.length > 0 && !provider.models.includes(binding.model.trim())) {
    return `role model ${binding.model.trim()} is not available for provider ${binding.providerId}`;
  }
  const providerInstructions = role.providerInstructions && typeof role.providerInstructions === 'object'
    ? Object.fromEntries(Object.entries(role.providerInstructions).filter(([key, value]) =>
      isValidAgentType(key) && typeof value === 'string' && value.trim(),
    ).map(([key, value]) => [key, (value as string).trim()])) as RoleConfig['providerInstructions']
    : undefined;
  return {
    id: role.id!,
    displayName: role.displayName.trim(),
    binding: { providerId: binding.providerId, model: binding.model.trim(), thinking: binding.thinking },
    instructions: role.instructions.trim(),
    providerInstructions,
  };
}

/** Validate the persistent Settings shape before it can replace the on-disk configuration. */
export function parseSettingsConfig(value: unknown): SettingsConfig | string {
  if (!value || typeof value !== 'object') return 'settings must be an object';
  const settings = value as Partial<SettingsConfig>;
  if (typeof settings.cloneRoot !== 'string' || !settings.cloneRoot.trim()) return 'cloneRoot is required';
  if (!Array.isArray(settings.providers)) return 'providers must be an array';
  const providers = settings.providers.map(parseProvider);
  const providerError = providers.find(item => typeof item === 'string');
  if (providerError) return providerError as string;
  const parsedProviders = providers as ProviderConfig[];
  if (new Set(parsedProviders.map(provider => provider.id)).size !== parsedProviders.length) return 'provider ids must be unique';
  if (parsedProviders.length !== VALID_AGENT_TYPES.length) return 'all built-in providers must remain configured';

  if (!Array.isArray(settings.roles)) return 'roles must be an array';
  const roles = settings.roles.map(role => parseRole(role, parsedProviders));
  const roleError = roles.find(item => typeof item === 'string');
  if (roleError) return roleError as string;
  const parsedRoles = roles as RoleConfig[];
  if (new Set(parsedRoles.map(role => role.id)).size !== parsedRoles.length) return 'role ids must be unique';
  if (parsedRoles.length !== BUILT_IN_ROLE_IDS.length) return 'all built-in roles must remain configured';

  return { cloneRoot: settings.cloneRoot.trim(), providers: parsedProviders, roles: parsedRoles };
}

/** Resolve and freeze a Role binding for one execution without mutating Settings. */
export function resolveRoleExecution(
  settings: SettingsConfig,
  roleId: RoleId,
  override: RoleBindingOverride = {},
): RoleExecutionSnapshot | string {
  const role = settings.roles.find(item => item.id === roleId);
  if (!role) return `role ${roleId} is not configured`;
  const providerId = override.providerId ?? role.binding.providerId;
  const model = override.model?.trim() || role.binding.model;
  const thinking = override.thinking ?? role.binding.thinking;
  const provider = settings.providers.find(item => item.id === providerId);
  if (!provider) return `role binding provider ${providerId} is not configured`;
  if (!provider.enabled) return `role binding provider ${providerId} is disabled`;
  if (provider.models.length > 0 && !provider.models.includes(model)) {
    return `role model ${model} is not available for provider ${providerId}`;
  }
  if (!isValidThinkingEffort(thinking)) return 'role binding thinking must be low, medium, or high';
  return {
    roleId: role.id,
    roleName: role.displayName,
    binding: { providerId, model, thinking },
    instructions: role.providerInstructions?.[providerId]?.trim() || role.instructions,
    capturedAt: Date.now(),
  };
}
