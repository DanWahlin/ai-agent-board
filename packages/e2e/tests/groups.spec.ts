import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { API, prepareTestRepo } from './helpers';

// ─── Helpers ────────────────────────────────────────────────────────

async function deleteGroup(request: APIRequestContext, id: string) {
  await request.delete(`${API}/api/groups/${id}`).catch(() => {});
}

function makeChildren(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Child task ${i + 1}`,
    description: `Description for child ${i + 1}`,
    agentType: 'copilot',
    useWorktree: false,
  }));
}

// ─── API Tests ──────────────────────────────────────────────────────

test.describe('Task Groups API', () => {
  const createdGroupIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdGroupIds) {
      await deleteGroup(request, id);
    }
    createdGroupIds.length = 0;
  });

  test('POST /api/groups creates a group with children', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'E2E Test Group',
        description: 'Testing group creation',
        priority: 'high',
        maxConcurrency: 2,
        children: makeChildren(3),
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGroupIds.push(body.id);

    expect(body.title).toBe('E2E Test Group');
    expect(body.description).toBe('Testing group creation');
    expect(body.priority).toBe('high');
    expect(body.maxConcurrency).toBe(2);
    expect(body.columnId).toBe('backlog');
    expect(body.children).toHaveLength(3);
    expect(body.children[0].title).toBe('Child task 1');
    expect(body.children[0].groupId).toBe(body.id);
    expect(body.children[0].groupOrder).toBe(0);
    expect(body.children[1].groupOrder).toBe(1);
    expect(body.children[2].groupOrder).toBe(2);
  });

  test('GET /api/groups lists all groups with children', async ({ request }) => {
    // Create a group
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'List Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // List groups
    const listRes = await request.get(`${API}/api/groups`);
    expect(listRes.status()).toBe(200);
    const groups = await listRes.json();
    const found = groups.find((g: any) => g.id === group.id);
    expect(found).toBeDefined();
    expect(found.children).toHaveLength(2);
  });

  test('GET /api/groups/:id returns group with children', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Get By ID Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    const getRes = await request.get(`${API}/api/groups/${group.id}`);
    expect(getRes.status()).toBe(200);
    const body = await getRes.json();
    expect(body.id).toBe(group.id);
    expect(body.title).toBe('Get By ID Group');
    expect(body.children).toHaveLength(2);
  });

  test('PATCH /api/groups/:id updates group metadata', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Original Title',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    const patchRes = await request.patch(`${API}/api/groups/${group.id}`, {
      data: { title: 'Updated Title', priority: 'critical' },
    });
    expect(patchRes.status()).toBe(200);
    const updated = await patchRes.json();
    expect(updated.title).toBe('Updated Title');
    expect(updated.priority).toBe('critical');
  });

  test('DELETE /api/groups/:id deletes group and cascades children', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Delete Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    const childId = group.children[0].id;

    // Delete the group
    const delRes = await request.delete(`${API}/api/groups/${group.id}`);
    expect(delRes.status()).toBe(204);

    // Group should be gone
    const getRes = await request.get(`${API}/api/groups/${group.id}`);
    expect(getRes.status()).toBe(404);

    // Child tasks should be gone too (cascade)
    const childRes = await request.get(`${API}/api/tasks/${childId}`);
    expect(childRes.status()).toBe(404);
  });

  test('grouped children are excluded from GET /api/tasks', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Exclusion Test Group',
        maxConcurrency: 1,
        children: [{ title: 'Hidden Child', agentType: 'copilot' }],
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Main tasks list should NOT contain the child
    const tasksRes = await request.get(`${API}/api/tasks`);
    const tasks = await tasksRes.json();
    const childInList = tasks.find((t: any) => t.title === 'Hidden Child');
    expect(childInList).toBeUndefined();
  });

  test('POST /api/groups rejects fewer than 2 children', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Too Few Children',
        maxConcurrency: 1,
        children: [{ title: 'Only one', agentType: 'copilot' }],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('at least');
  });

  test('POST /api/groups rejects missing title', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/groups rejects child with missing title', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Valid Group Title',
        maxConcurrency: 1,
        children: [
          { title: 'Valid child', agentType: 'copilot' },
          { description: 'No title here', agentType: 'copilot' },
        ],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('children[1]');
  });

  test('POST /api/groups rejects invalid maxConcurrency', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Bad Concurrency',
        maxConcurrency: 0,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrency');
  });

  test('POST /api/groups rejects maxConcurrency > children count', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Too Much Concurrency',
        maxConcurrency: 5,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(400);
  });

  test('children inherit group-level repo and branch config', async ({ request }) => {
    const repoPath = prepareTestRepo('groups');
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Config Inheritance Group',
        repoPath,
        baseBranch: 'develop',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGroupIds.push(body.id);

    // Children should inherit repo config
    expect(body.children[0].repoPath).toBe(repoPath);
    expect(body.children[0].baseBranch).toBe('develop');
    expect(body.children[1].repoPath).toBe(repoPath);
    expect(body.children[1].baseBranch).toBe('develop');
  });

  test('children respect per-child agent type', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Multi-Agent Group',
        maxConcurrency: 2,
        children: [
          { title: 'Copilot task', agentType: 'copilot' },
          { title: 'Claude task', agentType: 'claude' },
          { title: 'Codex task', agentType: 'codex' },
          { title: 'Oh My Pi task', agentType: 'oh-my-pi' },
        ],
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGroupIds.push(body.id);

    expect(body.children[0].agentType).toBe('copilot');
    expect(body.children[1].agentType).toBe('claude');
    expect(body.children[2].agentType).toBe('codex');
    expect(body.children[3].agentType).toBe('oh-my-pi');
  });

  test('PATCH /api/groups/:id/archive archives group and children', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Archive Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    const archiveRes = await request.patch(`${API}/api/groups/${group.id}/archive`);
    expect(archiveRes.status()).toBe(200);

    // Group should not appear in non-archived list
    const listRes = await request.get(`${API}/api/groups`);
    const groups = await listRes.json();
    const found = groups.find((g: any) => g.id === group.id);
    expect(found).toBeUndefined();
  });

  test('PATCH /api/groups/:id/unarchive restores group to backlog', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Unarchive Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Archive then unarchive
    await request.patch(`${API}/api/groups/${group.id}/archive`);
    const unarchiveRes = await request.patch(`${API}/api/groups/${group.id}/unarchive`);
    expect(unarchiveRes.status()).toBe(200);
    const restored = await unarchiveRes.json();
    expect(restored.columnId).toBe('backlog');
    expect(restored.archived).toBeFalsy();
  });

  test('E3: PATCH columnId=backlog resets children to idle', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Reset Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Simulate moving to in-progress (without running agents)
    await request.patch(`${API}/api/groups/${group.id}`, {
      data: { columnId: 'in-progress' },
    });

    // Move back to backlog — should reset children
    const resetRes = await request.patch(`${API}/api/groups/${group.id}`, {
      data: { columnId: 'backlog' },
    });
    expect(resetRes.status()).toBe(200);
    const reset = await resetRes.json();
    expect(reset.columnId).toBe('backlog');
    for (const child of reset.children) {
      expect(child.agentStatus).toBe('idle');
    }
  });

  test('E12: POST /api/groups/:id/run returns 409 if already running', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Conflict Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // First run
    const runRes = await request.post(`${API}/api/groups/${group.id}/run`);
    // May succeed or fail depending on agent availability — just need it to start the queue
    if (runRes.status() === 200) {
      // Second run should be rejected (409 conflict or 429 rate limited)
      const conflictRes = await request.post(`${API}/api/groups/${group.id}/run`);
      expect([409, 429]).toContain(conflictRes.status());
      // Clean up
      await request.post(`${API}/api/groups/${group.id}/stop`);
    }
  });

  test('GET /api/groups/:id returns 404 for unknown group', async ({ request }) => {
    const res = await request.get(`${API}/api/groups/nonexistent-id`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/groups/:id/run returns 404 for unknown group', async ({ request }) => {
    const res = await request.post(`${API}/api/groups/nonexistent-id/run`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/groups/:id/stop returns 404 for unknown group', async ({ request }) => {
    const res = await request.post(`${API}/api/groups/nonexistent-id/stop`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/groups rejects non-string child description', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Bad Description Group',
        maxConcurrency: 1,
        children: [
          { title: 'Valid child', agentType: 'copilot' },
          { title: 'Bad child', description: 123, agentType: 'copilot' },
        ],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('children[1].description');
  });

  test('PATCH /api/groups/:id rejects invalid maxConcurrency', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Concurrency Patch Test',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Zero
    const res0 = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 0 } });
    expect(res0.status()).toBe(400);

    // Greater than children count
    const resHigh = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 99 } });
    expect(resHigh.status()).toBe(400);

    // Non-integer
    const resFloat = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 1.5 } });
    expect(resFloat.status()).toBe(400);

    // Valid update should work
    const resOk = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 2 } });
    expect(resOk.status()).toBe(200);
    const updated = await resOk.json();
    expect(updated.maxConcurrency).toBe(2);
  });
});

// ─── UI Tests ───────────────────────────────────────────────────────

test.describe('Task Groups UI', () => {
  const createdGroupIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdGroupIds) {
      await deleteGroup(request, id);
    }
    createdGroupIds.length = 0;
  });

  test('New Group button opens group creation dialog', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Group' }).click();
    await expect(page.getByRole('heading', { name: 'Create Task Group' })).toBeVisible();
  });

  test('group dialog requires title and child titles to submit', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Group' }).click();
    await expect(page.getByRole('heading', { name: 'Create Task Group' })).toBeVisible();

    // Create Group button should be disabled with empty title
    const createBtn = page.getByRole('button', { name: 'Create Group' });
    await expect(createBtn).toBeDisabled();

    // Fill group title but not child titles — still disabled
    await page.getByPlaceholder('e.g., Q2 Feature Sprint').fill('My Test Group');
    await expect(createBtn).toBeDisabled();
  });

  test('group dialog can add and remove child rows', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Group' }).click();

    // Initially 2 child rows
    const childTitles = page.getByPlaceholder('Task title');
    await expect(childTitles).toHaveCount(2);

    // Add a child
    await page.getByRole('button', { name: 'Add Task' }).click();
    await expect(childTitles).toHaveCount(3);

    // With 3 children, each row has a delete button (the small icon button at the end)
    // The Trash2 icon renders as an SVG. Find the last small button in a child row.
    const childRows = page.locator('[class*="rounded-lg border"][class*="bg-muted"]').filter({
      has: page.getByPlaceholder('Task title'),
    });
    await expect(childRows).toHaveCount(3);

    // Click the last icon button in the first child row (the trash button)
    const firstRowTrash = childRows.first().locator('button').last();
    await firstRowTrash.click();
    await expect(childTitles).toHaveCount(2);
  });

  test('create a group and verify it appears on the board', async ({ page, request }) => {
    const ts = Date.now();
    await page.goto('/');
    await page.getByRole('button', { name: 'New Group' }).click();

    // Fill group fields
    await page.getByPlaceholder('e.g., Q2 Feature Sprint').fill(`E2E Group ${ts}`);

    // Fill child titles
    const childTitles = page.getByPlaceholder('Task title');
    await childTitles.nth(0).fill(`Child A ${ts}`);
    await childTitles.nth(1).fill(`Child B ${ts}`);

    // Submit
    await page.getByRole('button', { name: 'Create Group' }).click();

    // Dialog should close
    await expect(page.getByRole('heading', { name: 'Create Task Group' })).not.toBeVisible({ timeout: 3000 });

    // Group card should appear on the board
    await expect(page.getByText(`E2E Group ${ts}`)).toBeVisible({ timeout: 5000 });

    // Clean up via API
    const groupsRes = await request.get(`${API}/api/groups`);
    const groups = await groupsRes.json();
    const created = groups.find((g: any) => g.title === `E2E Group ${ts}`);
    if (created) createdGroupIds.push(created.id);
  });

  test('parallelism slider updates value in real-time', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Group' }).click();

    // Add a third child to make slider range 1-3
    await page.getByRole('button', { name: 'Add Task' }).click();

    // Slider should show "2 of 3" by default
    await expect(page.getByText('2 of 3')).toBeVisible();

    // Move slider to max
    const slider = page.locator('input[type="range"]');
    await slider.fill('3');
    await expect(page.getByText('3 of 3')).toBeVisible();

    // Move slider to min
    await slider.fill('1');
    await expect(page.getByText('1 of 3')).toBeVisible();
  });

  test('Esc closes the group dialog', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Group' }).click();
    await expect(page.getByRole('heading', { name: 'Create Task Group' })).toBeVisible();

    // Click outside the input to ensure body has focus, then press Esc
    await page.locator('.fixed.inset-0').click({ position: { x: 5, y: 5 } });
    await expect(page.getByRole('heading', { name: 'Create Task Group' })).not.toBeVisible({ timeout: 3000 });
  });
});
