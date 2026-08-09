import { test, expect, type Page } from '@playwright/test';
import { API, fillLocalPath, waitForBoard } from './helpers';

const AGENT_LABELS: Record<string, string> = {
  copilot: 'Copilot',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  'oh-my-pi': 'Oh My Pi',
};

const AGENT_LABEL_ORDER = Object.values(AGENT_LABELS);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getPreferredAgent(request: any): Promise<{ name: string; label: string; hasAvailableAgent: boolean }> {
  const res = await request.get(`${API}/api/agents`);
  const agents = await res.json();
  const preferred = agents.find((agent: any) => agent.available)?.name ?? 'copilot';
  return {
    name: preferred,
    label: AGENT_LABELS[preferred] ?? preferred,
    hasAvailableAgent: agents.some((agent: any) => agent.available),
  };
}

async function openCreateDialog(page: Page) {
  const backlogHeading = page.getByRole('heading', { name: 'Backlog', exact: true });
  const headerRow = backlogHeading.locator('..').locator('..');
  const addButton = headerRow.locator('button').first();
  await addButton.click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
}

async function createTask(page: Page, title: string, description = 'Test description') {
  await openCreateDialog(page);
  await page.getByPlaceholder('What needs to be done?').fill(title);
  await page.getByPlaceholder('Describe the task for the selected agent...').fill(description);
  // Local path is required — fill with a valid path
  await fillLocalPath(page);
  await page.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 3_000 });
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 5_000 });
}

/** Create a task and move it to in-progress via API, then reload. Returns the task id. */
async function createTaskInProgress(page: Page, title: string, opts?: { agentType?: string }) {
  await createTask(page, title);

  const taskId = await page.evaluate(async (t) => {
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    return tasks.find((tk: any) => tk.title === t)?.id;
  }, title);

  // Move to in-progress (and optionally set agentType)
  const patchBody: Record<string, string> = { columnId: 'in-progress' };
  if (opts?.agentType) patchBody.agentType = opts.agentType;

  await page.evaluate(async ({ id, body }) => {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }, { id: taskId, body: patchBody });

  await page.reload();
  await waitForBoard(page);
  return taskId as string;
}

/** Open the Create/Edit Task dialog's agent dropdown and return it. */
async function openAgentDropdown(page: Page) {
  const dialog = page.locator('[role="dialog"]');
  // Click the Agent dropdown button
  const agentLabel = dialog.getByText('Agent', { exact: true });
  const agentButton = agentLabel.locator('..').locator('button').first();
  await agentButton.click();
  return dialog;
}

// ---------------------------------------------------------------------------
// Tests – TaskDialog agent selector
// ---------------------------------------------------------------------------

test.describe('Agent Selector in TaskDialog', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('shows agent dropdown with all supported agent options', async ({ page }) => {
    await openCreateDialog(page);
    const dialog = await openAgentDropdown(page);

    // The dropdown menu should show all supported agent options as buttons
    // Use role=button filter to avoid matching the trigger button text
    const dropdownOptions = dialog.locator('[class*="popover"] button');
    await expect(dropdownOptions).toHaveCount(AGENT_LABEL_ORDER.length);
    for (const [index, label] of AGENT_LABEL_ORDER.entries()) {
      await expect(dropdownOptions.nth(index)).toContainText(label);
    }
    await expect(dropdownOptions.filter({ hasText: 'Oh My Pi' })).toHaveCount(1);
  });

  test('clicking an available agent option selects it', async ({ page, request }) => {
    await openCreateDialog(page);
    const dialog = await openAgentDropdown(page);
    const selected = await getPreferredAgent(request);
    const dropdownOptions = dialog.locator('[class*="popover"] button');

    if (!selected.hasAvailableAgent) {
      await expect(dropdownOptions).toHaveCount(AGENT_LABEL_ORDER.length);
      // When no provider is available every option is disabled. The trailing
      // status text is the provider's reason (e.g. "... not found" or a
      // test-environment reason) and falls back to "Unavailable" only when the
      // reason is empty, so assert the disabled state rather than the label.
      for (let i = 0; i < AGENT_LABEL_ORDER.length; i++) {
        await expect(dropdownOptions.nth(i)).toBeDisabled();
      }
      return;
    }

    await dropdownOptions.filter({ hasText: selected.label }).first().click();

    // The dropdown button should now show the selected agent.
    const agentLabel = dialog.getByText('Agent', { exact: true });
    const agentButton = agentLabel.locator('..').locator('button').first();
    await expect(agentButton).toContainText(selected.label);
  });

  test('default agent selection follows provider availability', async ({ page, request }) => {
    await openCreateDialog(page);
    const dialog = page.locator('[role="dialog"]');
    const expected = await getPreferredAgent(request);

    // If Copilot is unavailable, the dialog defaults to the first available provider.
    const agentLabel = dialog.getByText('Agent', { exact: true });
    const agentButton = agentLabel.locator('..').locator('button').first();
    await expect(agentButton).toContainText(expected.label);
  });
});

// ---------------------------------------------------------------------------
// Tests – Agent type badge on task cards
// ---------------------------------------------------------------------------

test.describe('Agent Type Badge on Task Cards', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('agent type badge appears on task card when agentType is set and column is not backlog', async ({ page }) => {
    const title = `BadgeTask ${Date.now()}`;
    const taskId = await createTaskInProgress(page, title, { agentType: 'copilot' });
    createdTaskIds.push(taskId);

    // The card in in-progress should show the Copilot agent badge
    const card = page.locator('.group').filter({ has: page.getByRole('heading', { name: title }) });
    await expect(card.getByText('Copilot')).toBeVisible();
  });

  test('agent type badge does NOT appear on backlog cards', async ({ page }) => {
    const title = `NoBadge ${Date.now()}`;
    await createTask(page, title);

    // Set agentType via API but keep in backlog
    const taskId = await page.evaluate(async (t) => {
      const res = await fetch('/api/tasks');
      const tasks = await res.json();
      return tasks.find((tk: any) => tk.title === t)?.id;
    }, title);

    await page.evaluate(async ({ id }) => {
      await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'claude' }),
      });
    }, { id: taskId });
    if (taskId) createdTaskIds.push(taskId);

    await page.reload();
    await waitForBoard(page);

    // The card should still be in backlog — verify it's visible
    const card = page.locator('.group').filter({ has: page.getByRole('heading', { name: title }) });
    await expect(card).toBeVisible();

    // The agent badge (emoji + label) should NOT be present on backlog cards
    // TaskCard renders: agentBadgeMap[task.agentType].emoji + " " + agentBadgeMap[task.agentType].label
    // Only shown when task.columnId !== 'backlog'
    const agentBadgePattern = new RegExp(`^\\s*(${AGENT_LABEL_ORDER.map(escapeRegExp).join('|')})$`);
    const agentBadge = card.locator('span').filter({ hasText: agentBadgePattern });
    await expect(agentBadge).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Tests – Agent Panel header shows agent type
// ---------------------------------------------------------------------------

test.describe('Agent Panel Header', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('shows the agent type emoji and label when task has agentType', async ({ page }) => {
    const title = `PanelAgent ${Date.now()}`;
    const taskId = await createTaskInProgress(page, title, { agentType: 'copilot' });
    createdTaskIds.push(taskId);

    // Click to open the agent panel
    await page.getByRole('heading', { name: title }).click();
    await expect(page.getByRole('button', { name: 'Run agent' })).toBeVisible({ timeout: 3_000 });

    // The panel header should display "⚙️ Copilot" via agentDisplayMap
    await expect(page.getByText('Copilot').first()).toBeVisible();
  });
});
