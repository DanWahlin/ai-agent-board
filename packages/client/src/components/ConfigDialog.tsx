import { useEffect, useMemo, useState, type FormEvent, type SyntheticEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import type { ProviderConfig, RoleConfig, SettingsResponse } from '@/types';

interface ProviderTestResult {
  available: boolean;
  model: string;
  version?: string;
  message?: string;
  error?: string;
}

interface ConfigDialogProps {
  open: boolean;
  settings: SettingsResponse | null;
  onClose: () => void;
  onSaveCloneRoot: (cloneRoot: string) => Promise<unknown>;
  onSaveProvider: (provider: ProviderConfig) => Promise<unknown>;
  onSaveRole: (role: RoleConfig) => Promise<unknown>;
  onTestProvider: (providerId: string, model: string) => Promise<ProviderTestResult | undefined>;
}

const csv = (value: string[]) => value.join(', ');
const splitCsv = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);

export function ConfigDialog({ open, settings, onClose, onSaveCloneRoot, onSaveProvider, onSaveRole, onTestProvider }: ConfigDialogProps) {
  const [tab, setTab] = useState<'providers' | 'roles'>('providers');
  const [providerId, setProviderId] = useState('codex');
  const [roleId, setRoleId] = useState('orchestrator');
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [role, setRole] = useState<RoleConfig | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [cloneRoot, setCloneRoot] = useState('');
  const validation = useMemo(() => new Map(settings?.providerValidation.map(item => [item.id, item]) ?? []), [settings]);

  useEffect(() => {
    if (!open || !settings) return;
    const nextProvider = settings.providers.find(item => item.id === providerId) ?? settings.providers[0] ?? null;
    const nextRole = settings.roles.find(item => item.id === roleId) ?? settings.roles[0] ?? null;
    setProvider(nextProvider ? { ...nextProvider, commandArgs: [...nextProvider.commandArgs], models: [...nextProvider.models], capabilities: [...nextProvider.capabilities] } : null);
    setRole(nextRole ? { ...nextRole, binding: { ...nextRole.binding }, providerInstructions: nextRole.providerInstructions ? { ...nextRole.providerInstructions } : undefined } : null);
    setError('');
    setTestResult(null);
    setSubmitting(false);
    setTesting(false);
    setCloneRoot(settings.cloneRoot);
  }, [open, settings, providerId, roleId]);

  async function saveCloneRoot(event: SyntheticEvent) {
    event.preventDefault();
    if (!cloneRoot.trim() || submitting) { setError('Clone root is required'); return; }
    setSubmitting(true); setError('');
    try { if ((await onSaveCloneRoot(cloneRoot.trim())) === undefined) setError('Failed to save clone root'); }
    finally { setSubmitting(false); }
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    if (!provider || submitting) return;
    setSubmitting(true); setError('');
    try { if ((await onSaveProvider(provider)) === undefined) setError('Failed to save provider configuration'); }
    finally { setSubmitting(false); }
  }

  async function saveRole(event: FormEvent) {
    event.preventDefault();
    if (!role || submitting) return;
    setSubmitting(true); setError('');
    try { if ((await onSaveRole(role)) === undefined) setError('Failed to save role configuration'); }
    finally { setSubmitting(false); }
  }

  async function testModel() {
    if (!provider || testing) return;
    const model = provider.defaultModel || provider.models[0] || '';
    if (!model) { setError('Add at least one model before testing'); return; }
    setTesting(true); setTestResult(null); setError('');
    try {
      const result = await onTestProvider(provider.id, model);
      if (result) setTestResult(result);
      else setError('Failed to test provider');
    } finally { setTesting(false); }
  }

  // Settings are fetched independently from the projects list. If the server
  // is unavailable, keep the settings dialog closed instead of showing an
  // empty modal over the page.
  if (!open || !settings) return null;
  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div role="dialog" aria-modal="true" aria-label="Settings" initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4"><div><h2 className="text-base font-semibold">Settings</h2><p className="mt-0.5 text-xs text-muted-foreground">Configure execution providers and global role defaults.</p></div><button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close"><X className="h-4 w-4" /></button></div>
        <div className="flex gap-2 border-b border-border px-6 pt-3"><button type="button" onClick={() => setTab('providers')} className={`border-b-2 px-3 pb-3 text-sm font-medium ${tab === 'providers' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}>Providers</button><button type="button" onClick={() => setTab('roles')} className={`border-b-2 px-3 pb-3 text-sm font-medium ${tab === 'roles' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}>Roles</button></div>
        {!settings ? <div className="p-6 text-sm text-muted-foreground">Loading settings…</div> : tab === 'providers' ? (
          <form onSubmit={saveProvider} className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-6 md:grid-cols-[12rem_1fr]">
            <aside aria-label="Provider list" className="space-y-1">{settings.providers.map(item => { const status = validation.get(item.id); return <button key={item.id} type="button" onClick={() => { setProviderId(item.id); setError(''); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${providerId === item.id ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}><span>{item.displayName}</span>{status?.available ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="Ready" /> : <CircleAlert className="h-4 w-4 text-amber-500" aria-label="Unavailable" />}</button>; })}</aside>
            {provider && <div className="space-y-4"><div className="flex items-center justify-between"><h3 className="font-medium">{provider.displayName}</h3><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={provider.enabled} onChange={event => setProvider({ ...provider, enabled: event.target.checked })} /> Enabled</label></div><div className={`rounded-lg border px-3 py-2 text-sm ${validation.get(provider.id)?.available ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{validation.get(provider.id)?.available ? `Ready${validation.get(provider.id)?.version ? ` · ${validation.get(provider.id)?.version}` : ''}` : validation.get(provider.id)?.reason || 'CLI availability has not been confirmed'}</div><label className="block text-xs font-medium text-muted-foreground">CLI command<input value={provider.cliCommand} onChange={event => setProvider({ ...provider, cliCommand: event.target.value })} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" /></label><label className="block text-xs font-medium text-muted-foreground">Command arguments (comma-separated)<input value={csv(provider.commandArgs)} onChange={event => setProvider({ ...provider, commandArgs: splitCsv(event.target.value) })} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" /></label><label className="block text-xs font-medium text-muted-foreground">Default model<select aria-label="Default model" value={provider.defaultModel ?? provider.models[0] ?? ''} onChange={event => setProvider({ ...provider, defaultModel: event.target.value })} disabled={provider.models.length === 0} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{provider.models.length === 0 ? <option value="">Models unavailable from provider</option> : provider.models.map(model => <option key={model} value={model}>{model}</option>)}</select></label><div className="flex items-center gap-2"><button type="button" onClick={testModel} disabled={testing || !provider.enabled || provider.models.length === 0} className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50">{testing ? 'Testing…' : 'Test model availability'}</button>{testResult && <span className={`text-xs ${testResult.available ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>{testResult.available ? `${testResult.message || 'Model is available'}${testResult.version ? ` · ${testResult.version}` : ''}` : testResult.error || testResult.message || 'Model is unavailable'}</span>}</div><label className="block text-xs font-medium text-muted-foreground">Capabilities (comma-separated)<input value={csv(provider.capabilities)} onChange={event => setProvider({ ...provider, capabilities: splitCsv(event.target.value) })} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><div className="rounded-lg border border-border bg-background p-3"><label className="block text-xs font-medium text-muted-foreground">Clone root<input value={cloneRoot} onChange={event => setCloneRoot(event.target.value)} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" /></label><button type="button" onClick={saveCloneRoot} disabled={submitting} className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">Save clone root</button></div><div className="flex justify-end"><button type="submit" disabled={submitting} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{submitting ? 'Saving…' : 'Save provider'}</button></div></div>}
          </form>
        ) : (
          <form onSubmit={saveRole} className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-6 md:grid-cols-[12rem_1fr]">
            <aside aria-label="Role list" className="space-y-1">{settings.roles.map(item => <button key={item.id} type="button" onClick={() => { setRoleId(item.id); setError(''); }} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${roleId === item.id ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}>{item.displayName}</button>)}</aside>
            {role && <div className="space-y-4"><h3 className="font-medium">{role.displayName}</h3><div className="grid gap-4 sm:grid-cols-2"><label className="block text-xs font-medium text-muted-foreground">Provider binding<select value={role.binding.providerId} onChange={event => { const providerId = event.target.value as RoleConfig['binding']['providerId']; const nextProvider = settings.providers.find(item => item.id === providerId); const instructions = role.providerInstructions?.[providerId] ?? role.instructions; setRole({ ...role, binding: { ...role.binding, providerId, model: nextProvider?.defaultModel ?? nextProvider?.models[0] ?? role.binding.model }, instructions, providerInstructions: { ...role.providerInstructions, [providerId]: instructions } }); }} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{settings.providers.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label className="block text-xs font-medium text-muted-foreground">Thinking effort<select value={role.binding.thinking} onChange={event => setRole({ ...role, binding: { ...role.binding, thinking: event.target.value as RoleConfig['binding']['thinking'] } })} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div><label className="block text-xs font-medium text-muted-foreground">Model<select aria-label="Model" value={(settings.providers.find(item => item.id === role.binding.providerId)?.models ?? []).length > 0 ? role.binding.model : ''} onChange={event => setRole({ ...role, binding: { ...role.binding, model: event.target.value } })} className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{(settings.providers.find(item => item.id === role.binding.providerId)?.models ?? []).length === 0 ? <option value="">Models unavailable from provider</option> : settings.providers.find(item => item.id === role.binding.providerId)?.models.map(model => <option key={model} value={model}>{model}</option>)}</select></label><label className="block text-xs font-medium text-muted-foreground">Agent instructions<textarea value={role.instructions} onChange={event => setRole({ ...role, instructions: event.target.value, providerInstructions: { ...role.providerInstructions, [role.binding.providerId]: event.target.value } })} rows={7} className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><p className="text-xs text-muted-foreground">Instructions are embedded per provider and are not loaded from the Vault at runtime. A runtime override will be frozen for the current task or handoff without changing this role.</p><div className="flex justify-end"><button type="submit" disabled={submitting} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{submitting ? 'Saving…' : 'Save role'}</button></div></div>}
          </form>
        )}
        {error && <div className="mx-6 mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
      </motion.div>
    </AnimatePresence>
  );
}
