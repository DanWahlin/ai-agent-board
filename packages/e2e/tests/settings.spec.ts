import { test, expect } from '@playwright/test';
import { API } from './helpers';

test.describe('Settings provider and role configuration', () => {
  test('exposes independently editable Codex and Copilot providers and roles', async ({ page, request }) => {
    const initial = await request.get(`${API}/api/settings`);
    expect(initial.ok()).toBeTruthy();
    const settings = await initial.json() as { providers: Array<{ id: string; cliCommand: string; models: string[]; defaultModel?: string }>; roles: Array<{ id: string }> };
    expect(settings.providers.map(provider => provider.id)).toEqual(expect.arrayContaining(['codex', 'copilot']));
    expect(settings.roles.map(role => role.id)).toEqual(expect.arrayContaining(['orchestrator', 'research', 'implementor', 'reviewer', 'knowledge']));

    await page.goto('/projects');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Codex CLI' }).click();
    const command = page.getByLabel('CLI command');
    await command.fill('codex');
    const codexModel = settings.providers.find(provider => provider.id === 'codex')?.defaultModel
      ?? settings.providers.find(provider => provider.id === 'codex')?.models[0];
    if (codexModel) await expect(page.getByLabel('Default model')).toHaveValue(codexModel);
    await page.getByRole('button', { name: 'Save provider' }).click();
    await expect(command).toHaveValue('codex');

    await page.getByRole('button', { name: 'Roles' }).click();
    await page.getByRole('button', { name: 'Orchestrator' }).click();
    if (codexModel) await expect(page.getByLabel('Model')).toHaveValue(codexModel);
    await page.getByRole('button', { name: 'Save role' }).click();
    if (codexModel) await expect(page.getByLabel('Model')).toHaveValue(codexModel);

    const resolved = await request.post(`${API}/api/settings/roles/orchestrator/resolve`, {
      data: { providerId: 'copilot', model: 'claude-opus-4-20250514', thinking: 'low' },
    });
    expect(resolved.ok()).toBeTruthy();
    const snapshot = await resolved.json() as { binding: { providerId: string; model: string; thinking: string }; instructions: string };
    expect(snapshot.binding).toEqual({ providerId: 'copilot', model: 'claude-opus-4-20250514', thinking: 'low' });
    expect(snapshot.instructions).toContain('Windows Orchestrator');
    const unchanged = await request.get(`${API}/api/settings`);
    const after = await unchanged.json() as { roles: Array<{ id: string; binding: { providerId: string } }> };
    expect(after.roles.find(role => role.id === 'orchestrator')?.binding.providerId).toBe('codex');
  });
});
