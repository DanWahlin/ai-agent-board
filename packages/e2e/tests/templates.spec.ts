import { test, expect } from '@playwright/test';
import { API } from './helpers';

// Helper — delete template by ID (cleanup)
async function deleteTemplate(request: any, id: string) {
  await request.delete(`${API}/api/templates/${id}`);
}

test.describe('Templates CRUD', () => {
  let createdIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdIds) {
      await deleteTemplate(request, id);
    }
    createdIds = [];
  });

  test('POST /api/templates creates a template', async ({ request }) => {
    const res = await request.post(`${API}/api/templates`, {
      data: {
        name: 'Bug Fix Template',
        title: 'Fix bug in {{module}}',
        description: 'Investigate and fix the reported bug',
        priority: 'high',
        agentType: 'copilot',
      },
    });
    expect(res.status()).toBe(201);
    const template = await res.json();
    createdIds.push(template.id);

    expect(template.name).toBe('Bug Fix Template');
    expect(template.title).toBe('Fix bug in {{module}}');
    expect(template.description).toBe('Investigate and fix the reported bug');
    expect(template.priority).toBe('high');
    expect(template.agentType).toBe('copilot');
    expect(template.id).toBeTruthy();
    expect(template.createdAt).toBeGreaterThan(0);
  });

  test('POST /api/templates accepts Oh My Pi agent type', async ({ request }) => {
    const res = await request.post(`${API}/api/templates`, {
      data: {
        name: 'Oh My Pi Template',
        title: 'Use Oh My Pi',
        agentType: 'oh-my-pi',
      },
    });
    expect(res.status()).toBe(201);
    const template = await res.json();
    createdIds.push(template.id);

    expect(template.agentType).toBe('oh-my-pi');
  });

  test('GET /api/templates lists all templates', async ({ request }) => {
    // Create two templates
    const r1 = await request.post(`${API}/api/templates`, {
      data: { name: 'Template A', title: 'Title A' },
    });
    const t1 = await r1.json();
    createdIds.push(t1.id);

    const r2 = await request.post(`${API}/api/templates`, {
      data: { name: 'Template B', title: 'Title B' },
    });
    const t2 = await r2.json();
    createdIds.push(t2.id);

    const listRes = await request.get(`${API}/api/templates`);
    expect(listRes.status()).toBe(200);
    const templates = await listRes.json();
    expect(Array.isArray(templates)).toBe(true);

    const ids = templates.map((t: any) => t.id);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
  });

  test('GET /api/templates/:id returns a single template', async ({ request }) => {
    const r = await request.post(`${API}/api/templates`, {
      data: { name: 'Single Fetch', title: 'Test' },
    });
    const created = await r.json();
    createdIds.push(created.id);

    const res = await request.get(`${API}/api/templates/${created.id}`);
    expect(res.status()).toBe(200);
    const template = await res.json();
    expect(template.id).toBe(created.id);
    expect(template.name).toBe('Single Fetch');
  });

  test('GET /api/templates/:id returns 404 for unknown template', async ({ request }) => {
    const res = await request.get(`${API}/api/templates/nonexistent-id`);
    expect(res.status()).toBe(404);
  });

  test('PATCH /api/templates/:id updates template fields', async ({ request }) => {
    const r = await request.post(`${API}/api/templates`, {
      data: { name: 'Original Name', title: 'Original Title', priority: 'low' },
    });
    const created = await r.json();
    createdIds.push(created.id);

    const res = await request.patch(`${API}/api/templates/${created.id}`, {
      data: { name: 'Updated Name', priority: 'critical' },
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe('Updated Name');
    expect(updated.priority).toBe('critical');
    expect(updated.title).toBe('Original Title'); // unchanged
  });

  test('PATCH /api/templates/:id returns 404 for unknown template', async ({ request }) => {
    const res = await request.patch(`${API}/api/templates/nonexistent-id`, {
      data: { name: 'Updated' },
    });
    expect(res.status()).toBe(404);
  });

  test('DELETE /api/templates/:id deletes a template', async ({ request }) => {
    const r = await request.post(`${API}/api/templates`, {
      data: { name: 'To Delete', title: 'Bye' },
    });
    const created = await r.json();

    const deleteRes = await request.delete(`${API}/api/templates/${created.id}`);
    expect(deleteRes.status()).toBe(204);

    // Verify gone
    const getRes = await request.get(`${API}/api/templates/${created.id}`);
    expect(getRes.status()).toBe(404);
  });

  test('DELETE /api/templates/:id returns 404 for unknown template', async ({ request }) => {
    const res = await request.delete(`${API}/api/templates/nonexistent-id`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/templates rejects missing name', async ({ request }) => {
    const res = await request.post(`${API}/api/templates`, {
      data: { title: 'No name' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name');
  });

  test('POST /api/templates rejects invalid priority', async ({ request }) => {
    const res = await request.post(`${API}/api/templates`, {
      data: { name: 'Bad Priority', priority: 'super-high' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('priority');
  });

  test('POST /api/templates rejects invalid agentType', async ({ request }) => {
    const res = await request.post(`${API}/api/templates`, {
      data: { name: 'Bad Agent', agentType: 'gpt-9000' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('agentType');
  });

  test('PATCH /api/templates/:id rejects empty name', async ({ request }) => {
    const r = await request.post(`${API}/api/templates`, {
      data: { name: 'Valid Name' },
    });
    const created = await r.json();
    createdIds.push(created.id);

    const res = await request.patch(`${API}/api/templates/${created.id}`, {
      data: { name: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/templates defaults priority to medium and agentType to copilot', async ({ request }) => {
    const res = await request.post(`${API}/api/templates`, {
      data: { name: 'Defaults Test' },
    });
    expect(res.status()).toBe(201);
    const template = await res.json();
    createdIds.push(template.id);

    expect(template.priority).toBe('medium');
    expect(template.agentType).toBe('copilot');
  });
});
