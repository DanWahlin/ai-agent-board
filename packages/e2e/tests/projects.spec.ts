import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { existsSync } from 'fs';
import path from 'path';
import { API, cleanupTestPath, prepareTestRepo, waitForBoard } from './helpers';

process.env.E2E_TEST_REPO_ROOT ??= path.resolve(process.cwd(), 'test-results', 'repos');

type Project = {
  id: string;
  name: string;
  repoPath?: string;
  repoUrl?: string;
  isDefault: boolean;
  taskCounts: Record<string, number>;
  defaultAgentType?: string;
  defaultPriority?: string;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
};

type Task = {
  id: string;
  title: string;
  projectId: string;
  repoPath?: string;
  columnId: string;
  agentType?: string;
  priority?: string;
  baseBranch?: string;
  useWorktree?: boolean;
};

type TaskGroup = {
  id: string;
  title: string;
  projectId: string;
  repoPath?: string;
  columnId: string;
  priority?: string;
  baseBranch?: string;
  children?: Task[];
};

async function createProject(
  request: APIRequestContext,
  data: {
    name?: string;
    repoPath?: string;
    defaultAgentType?: string;
    defaultPriority?: string;
    defaultBaseBranch?: string;
    defaultUseWorktree?: boolean;
  },
): Promise<Project> {
  const res = await request.post(`${API}/api/projects`, { data });
  expect(res.status()).toBe(201);
  return res.json();
}

async function deleteProject(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`${API}/api/projects/${id}`).catch(() => {});
}

async function createTask(
  request: APIRequestContext,
  data: {
    title: string;
    projectId?: string;
    repoPath?: string;
    columnId?: string;
    agentType?: string;
    priority?: string;
    baseBranch?: string;
    useWorktree?: boolean;
  },
): Promise<Task> {
  const payload: Record<string, unknown> = {
    title: data.title,
    description: 'Project-scoped task',
    columnId: data.columnId ?? 'backlog',
  };
  if (data.projectId !== undefined) payload.projectId = data.projectId;
  if (data.repoPath !== undefined) payload.repoPath = data.repoPath;
  if (data.agentType !== undefined) payload.agentType = data.agentType;
  if (data.priority !== undefined) payload.priority = data.priority;
  if (data.baseBranch !== undefined) payload.baseBranch = data.baseBranch;
  if (data.useWorktree !== undefined) payload.useWorktree = data.useWorktree;

  const res = await request.post(`${API}/api/tasks`, {
    data: payload,
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function createGroup(
  request: APIRequestContext,
  data: { title: string; projectId?: string; repoPath?: string; columnId?: string },
): Promise<TaskGroup> {
  const payload: Record<string, unknown> = {
    title: data.title,
    description: 'Project-scoped group',
    maxConcurrency: 1,
    children: [
      { title: `${data.title} child one` },
      { title: `${data.title} child two` },
    ],
  };
  if (data.projectId !== undefined) payload.projectId = data.projectId;
  if (data.repoPath !== undefined) payload.repoPath = data.repoPath;

  const res = await request.post(`${API}/api/groups`, { data: payload });
  expect(res.status()).toBe(201);
  const group = await res.json() as TaskGroup;
  if (data.columnId && data.columnId !== group.columnId) {
    const moveRes = await request.patch(`${API}/api/groups/${group.id}`, {
      data: { columnId: data.columnId },
    });
    expect(moveRes.status()).toBe(200);
    return moveRes.json();
  }
  return group;
}

async function openNewTaskDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New Task' }).click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
}

test.describe('Projects API', () => {
  const createdProjectIds: string[] = [];
  const createdTaskIds: string[] = [];
  const createdGroupIds: string[] = [];
  const cleanupPaths: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdGroupIds) {
      await request.delete(`${API}/api/groups/${id}`).catch(() => {});
    }
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    for (const id of createdProjectIds) {
      await deleteProject(request, id);
    }
    createdTaskIds.length = 0;
    createdGroupIds.length = 0;
    createdProjectIds.length = 0;
    for (const targetPath of cleanupPaths) {
      cleanupTestPath(targetPath);
    }
    cleanupPaths.length = 0;
  });

  test('keeps implicit task scope pinned to the seeded default project', async ({ request }) => {
    const defaultBeforeRes = await request.get(`${API}/api/projects/default`);
    expect(defaultBeforeRes.status()).toBe(200);
    const defaultBefore = await defaultBeforeRes.json() as Project;
    expect(defaultBefore).toMatchObject({ id: 'default', isDefault: true });

    const attackerRepo = prepareTestRepo('projects-api-default-attacker', { clean: true });
    const createDefaultRes = await request.post(`${API}/api/projects`, {
      data: {
        name: 'Attacker Default Project',
        repoPath: attackerRepo,
        isDefault: true,
      },
    });
    expect(createDefaultRes.status()).toBe(400);

    const normalProject = await createProject(request, {
      name: 'Normal Non Default Project',
      repoPath: prepareTestRepo('projects-api-normal-non-default', { clean: true }),
    });
    createdProjectIds.push(normalProject.id);

    const patchDefaultRes = await request.patch(`${API}/api/projects/${normalProject.id}`, {
      data: { isDefault: true },
    });
    expect(patchDefaultRes.status()).toBe(400);

    const defaultAfterRes = await request.get(`${API}/api/projects/default`);
    expect(defaultAfterRes.status()).toBe(200);
    await expect(defaultAfterRes.json()).resolves.toMatchObject({ id: 'default', isDefault: true });

    const defaultRepo = prepareTestRepo('projects-api-implicit-default-task', { clean: true });
    const implicitTask = await createTask(request, {
      title: 'Implicit Default Scope Task',
      repoPath: defaultRepo,
    });
    createdTaskIds.push(implicitTask.id);
    expect(implicitTask.projectId).toBe('default');

    const tasksRes = await request.get(`${API}/api/tasks`);
    expect(tasksRes.status()).toBe(200);
    const tasks = await tasksRes.json() as Task[];
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: implicitTask.id, projectId: 'default' }),
    ]));
  });

  test('rejects mismatched locked repo paths for tasks and groups', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-locked-repo', { clean: true });
    const otherRepoPath = prepareTestRepo('projects-api-other-repo', { clean: true });
    const project = await createProject(request, {
      name: 'Locked Repo Project',
      repoPath,
    });
    createdProjectIds.push(project.id);

    const mismatchedTaskRes = await request.post(`${API}/api/tasks`, {
      data: {
        title: 'Mismatched Locked Task',
        description: 'Should be rejected',
        projectId: project.id,
        repoPath: otherRepoPath,
      },
    });
    expect(mismatchedTaskRes.status()).toBe(400);
    await expect(mismatchedTaskRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/repoPath|project/i),
    });

    const task = await createTask(request, {
      title: 'Locked Task',
      projectId: project.id,
    });
    createdTaskIds.push(task.id);
    expect(task.repoPath).toBe(repoPath);

    const patchTaskRes = await request.patch(`${API}/api/tasks/${task.id}`, {
      data: { repoPath: otherRepoPath },
    });
    expect(patchTaskRes.status()).toBe(400);
    await expect(patchTaskRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/repoPath|locked|project/i),
    });

    const configureTaskRes = await request.post(`${API}/api/tasks/${task.id}/configure`, {
      data: {
        repoPath: otherRepoPath,
        branchName: 'locked-task-branch',
        baseBranch: 'main',
        useWorktree: true,
      },
    });
    expect(configureTaskRes.status()).toBe(400);
    await expect(configureTaskRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/repoPath|locked|project/i),
    });

    const mismatchedGroupRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Mismatched Locked Group',
        projectId: project.id,
        repoPath: otherRepoPath,
        maxConcurrency: 1,
        children: [{ title: 'Child one' }, { title: 'Child two' }],
      },
    });
    if (mismatchedGroupRes.status() === 201) {
      const group = await mismatchedGroupRes.json() as TaskGroup;
      createdGroupIds.push(group.id);
    }
    expect(mismatchedGroupRes.status()).toBe(400);

    const group = await createGroup(request, {
      title: 'Locked Group',
      projectId: project.id,
    });
    createdGroupIds.push(group.id);
    expect(group.repoPath).toBe(repoPath);

    const patchGroupRes = await request.patch(`${API}/api/groups/${group.id}`, {
      data: { repoPath: otherRepoPath },
    });
    expect(patchGroupRes.status()).toBe(400);
    await expect(patchGroupRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/repoPath|locked|project/i),
    });
  });

  test('rejects relative group repo paths for manual no-repo projects', async ({ request }) => {
    const project = await createProject(request, { name: 'Manual No Repo Group Project' });
    createdProjectIds.push(project.id);

    const relativeRepoName = `relative-group-repo-${Date.now()}`;
    const relativeRepoPath = `..\\e2e\\test-results\\${relativeRepoName}`;
    cleanupPaths.push(path.resolve(process.cwd(), 'test-results', relativeRepoName));

    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Relative Manual Group',
        projectId: project.id,
        repoPath: relativeRepoPath,
        maxConcurrency: 1,
        children: [{ title: 'Child one' }, { title: 'Child two' }],
      },
    });
    if (res.status() === 201) {
      const group = await res.json() as TaskGroup;
      createdGroupIds.push(group.id);
    }
    expect(res.status()).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/absolute|repoPath|Local Path/i),
    });
  });

  test('rejects task and group projectId changes after creation', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-projectid-immutable', { clean: true });
    const sourceProject = await createProject(request, { name: 'Source Project' });
    const targetProject = await createProject(request, { name: 'Target Project' });
    createdProjectIds.push(sourceProject.id, targetProject.id);

    const task = await createTask(request, {
      title: 'Immutable Project Task',
      projectId: sourceProject.id,
      repoPath,
    });
    createdTaskIds.push(task.id);

    const taskMoveRes = await request.patch(`${API}/api/tasks/${task.id}`, {
      data: { projectId: targetProject.id },
    });
    expect(taskMoveRes.status()).toBe(400);
    await expect(taskMoveRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/projectId|immutable/i),
    });

    const group = await createGroup(request, {
      title: 'Immutable Project Group',
      projectId: sourceProject.id,
      repoPath,
    });
    createdGroupIds.push(group.id);

    const groupMoveRes = await request.patch(`${API}/api/groups/${group.id}`, {
      data: { projectId: targetProject.id },
    });
    expect(groupMoveRes.status()).toBe(400);
    await expect(groupMoveRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/projectId|immutable/i),
    });
  });

  test('locks project repoPath changes once tasks or groups exist', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-repopath-lock-original', { clean: true });
    const replacementRepoPath = prepareTestRepo('projects-api-repopath-lock-replacement', { clean: true });
    const project = await createProject(request, {
      name: 'Repo Path Lock Project',
      repoPath,
    });
    createdProjectIds.push(project.id);

    const task = await createTask(request, {
      title: 'Repo Lock Task',
      projectId: project.id,
    });
    createdTaskIds.push(task.id);

    const group = await createGroup(request, {
      title: 'Repo Lock Group',
      projectId: project.id,
    });
    createdGroupIds.push(group.id);

    const replaceRes = await request.patch(`${API}/api/projects/${project.id}`, {
      data: { repoPath: replacementRepoPath },
    });
    expect(replaceRes.status()).toBe(409);
    await expect(replaceRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/repoPath|task|group|migration|locked/i),
    });

    const clearRes = await request.patch(`${API}/api/projects/${project.id}`, {
      data: { repoPath: null },
    });
    expect(clearRes.status()).toBe(409);
    await expect(clearRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/repoPath|task|group|migration|locked/i),
    });

    const deleteRes = await request.delete(`${API}/api/projects/${project.id}`);
    expect(deleteRes.status()).toBe(204);
  });

  test('deletes a non-empty project and cascades its tasks and groups', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-cascade-delete', { clean: true });
    const project = await createProject(request, {
      name: 'Cascade Delete Project',
      repoPath,
    });

    const task = await createTask(request, {
      title: 'Cascade Task',
      projectId: project.id,
    });
    const group = await createGroup(request, {
      title: 'Cascade Group',
      projectId: project.id,
    });

    const deleteRes = await request.delete(`${API}/api/projects/${project.id}`);
    expect(deleteRes.status()).toBe(204);

    const projectAfter = await request.get(`${API}/api/projects/${project.id}`);
    expect(projectAfter.status()).toBe(404);

    const taskAfter = await request.get(`${API}/api/tasks/${task.id}/events`);
    expect(taskAfter.status()).toBe(404);

    const groupAfter = await request.get(`${API}/api/groups/${group.id}`);
    expect(groupAfter.status()).toBe(404);
  });

  test('refuses to delete the default project', async ({ request }) => {
    const deleteRes = await request.delete(`${API}/api/projects/default`);
    expect(deleteRes.status()).toBe(409);
    const stillThere = await request.get(`${API}/api/projects/default`);
    expect(stillThere.status()).toBe(200);
  });

  test('summarizes only board-visible standalone tasks and groups', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-counts', { clean: true });
    const project = await createProject(request, {
      name: 'Counts Project',
      repoPath,
    });
    createdProjectIds.push(project.id);

    const activeTask = await createTask(request, {
      title: 'Active Standalone Count Task',
      projectId: project.id,
      columnId: 'backlog',
    });
    createdTaskIds.push(activeTask.id);

    const archivedTask = await createTask(request, {
      title: 'Archived Standalone Count Task',
      projectId: project.id,
      columnId: 'done',
    });
    createdTaskIds.push(archivedTask.id);
    const archiveTaskRes = await request.patch(`${API}/api/tasks/${archivedTask.id}/archive`);
    expect(archiveTaskRes.status()).toBe(200);

    const activeGroup = await createGroup(request, {
      title: 'Active Count Group',
      projectId: project.id,
    });
    createdGroupIds.push(activeGroup.id);

    const archivedGroup = await createGroup(request, {
      title: 'Archived Count Group',
      projectId: project.id,
    });
    createdGroupIds.push(archivedGroup.id);
    const archiveGroupRes = await request.patch(`${API}/api/groups/${archivedGroup.id}/archive`);
    expect(archiveGroupRes.status()).toBe(200);

    const res = await request.get(`${API}/api/projects/${project.id}`);
    expect(res.status()).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: project.id,
      taskCounts: { backlog: 2, 'in-progress': 0, review: 0, done: 0, total: 2 },
    });
  });

  test('rejects project repo paths that are not absolute', async ({ request }) => {
    const res = await request.post(`${API}/api/projects`, {
      data: { name: 'Unsafe Project', repoPath: '..\\relative-repo' },
    });
    expect(res.status()).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/absolute|repoPath|Local Path/i),
    });
  });

  test('validates project repo paths without creating missing directories', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-validate-path', { clean: true });
    const validRes = await request.post(`${API}/api/projects/validate-path`, {
      data: { repoPath },
    });
    expect(validRes.status()).toBe(200);
    await expect(validRes.json()).resolves.toMatchObject({
      repoPath,
      valid: true,
      exists: true,
      isDirectory: true,
      isGitRepo: true,
    });

    const missingPath = path.join(process.env.E2E_TEST_REPO_ROOT!, `missing-project-${Date.now()}`);
    cleanupPaths.push(missingPath);
    const missingRes = await request.post(`${API}/api/projects/validate-path`, {
      data: { repoPath: missingPath },
    });
    expect(missingRes.status()).toBe(200);
    await expect(missingRes.json()).resolves.toMatchObject({
      valid: false,
      exists: false,
      error: expect.stringMatching(/does not exist/i),
    });
    expect(existsSync(missingPath)).toBe(false);
  });

  test('applies project task defaults and allows per-task overrides', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-defaults', { clean: true });
    const project = await createProject(request, {
      name: 'Defaults Project',
      repoPath,
      defaultAgentType: 'oh-my-pi',
      defaultPriority: 'high',
      defaultBaseBranch: 'develop',
      defaultUseWorktree: true,
    });
    createdProjectIds.push(project.id);
    expect(project).toMatchObject({
      defaultAgentType: 'oh-my-pi',
      defaultPriority: 'high',
      defaultBaseBranch: 'develop',
      defaultUseWorktree: true,
    });

    // Task created with no agent/priority/branch/worktree inherits the project defaults
    const inherited = await createTask(request, {
      title: 'Inherits Project Defaults',
      projectId: project.id,
    });
    createdTaskIds.push(inherited.id);
    expect(inherited).toMatchObject({
      agentType: 'oh-my-pi',
      priority: 'high',
      baseBranch: 'develop',
      useWorktree: true,
    });

    // Explicit values override the defaults (including useWorktree: false)
    const overridden = await createTask(request, {
      title: 'Overrides Project Defaults',
      projectId: project.id,
      agentType: 'copilot',
      priority: 'low',
      baseBranch: 'main',
      useWorktree: false,
    });
    createdTaskIds.push(overridden.id);
    expect(overridden).toMatchObject({
      agentType: 'copilot',
      priority: 'low',
      baseBranch: 'main',
      useWorktree: false,
    });
  });

  test('updates and clears project task defaults via PATCH', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-defaults-patch', { clean: true });
    const project = await createProject(request, {
      name: 'Defaults Patch Project',
      repoPath,
      defaultAgentType: 'codex',
      defaultUseWorktree: false,
    });
    createdProjectIds.push(project.id);

    const updateRes = await request.patch(`${API}/api/projects/${project.id}`, {
      data: { defaultAgentType: 'opencode', defaultPriority: 'critical', defaultBaseBranch: 'release' },
    });
    expect(updateRes.status()).toBe(200);
    await expect(updateRes.json()).resolves.toMatchObject({
      defaultAgentType: 'opencode',
      defaultPriority: 'critical',
      defaultBaseBranch: 'release',
      defaultUseWorktree: false,
    });

    const clearRes = await request.patch(`${API}/api/projects/${project.id}`, {
      data: { defaultAgentType: null, defaultPriority: null, defaultBaseBranch: null, defaultUseWorktree: null },
    });
    expect(clearRes.status()).toBe(200);
    const cleared = await clearRes.json() as Project;
    expect(cleared.defaultAgentType).toBeUndefined();
    expect(cleared.defaultPriority).toBeUndefined();
    expect(cleared.defaultBaseBranch).toBeUndefined();
    expect(cleared.defaultUseWorktree).toBeUndefined();
  });

  test('rejects invalid project task defaults', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-defaults-invalid', { clean: true });
    const agentRes = await request.post(`${API}/api/projects`, {
      data: { name: 'Bad Agent Project', repoPath, defaultAgentType: 'not-an-agent' },
    });
    expect(agentRes.status()).toBe(400);

    const priorityRes = await request.post(`${API}/api/projects`, {
      data: { name: 'Bad Priority Project', repoPath, defaultPriority: 'urgent' },
    });
    expect(priorityRes.status()).toBe(400);

    const branchRes = await request.post(`${API}/api/projects`, {
      data: { name: 'Bad Branch Project', repoPath, defaultBaseBranch: 'bad branch~name' },
    });
    expect(branchRes.status()).toBe(400);
  });

  test('applies project defaults to group children with per-child overrides', async ({ request }) => {
    const repoPath = prepareTestRepo('projects-api-group-defaults', { clean: true });
    const project = await createProject(request, {
      name: 'Group Defaults Project',
      repoPath,
      defaultAgentType: 'claude',
      defaultPriority: 'high',
      defaultBaseBranch: 'develop',
      defaultUseWorktree: false,
    });
    createdProjectIds.push(project.id);

    // Group + children with no agent/priority/branch/worktree inherit project defaults
    const inheritRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Inherits Group Defaults',
        projectId: project.id,
        maxConcurrency: 1,
        children: [
          { title: 'Inheriting child one' },
          { title: 'Inheriting child two' },
        ],
      },
    });
    expect(inheritRes.status()).toBe(201);
    const inheritGroup = await inheritRes.json() as TaskGroup;
    createdGroupIds.push(inheritGroup.id);
    expect(inheritGroup).toMatchObject({ priority: 'high', baseBranch: 'develop' });
    for (const child of inheritGroup.children ?? []) {
      expect(child).toMatchObject({ agentType: 'claude', priority: 'high', useWorktree: false });
    }

    // Explicit values override the defaults
    const overrideRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Overrides Group Defaults',
        projectId: project.id,
        priority: 'low',
        baseBranch: 'main',
        maxConcurrency: 1,
        children: [
          { title: 'Override child', agentType: 'copilot', useWorktree: true },
          { title: 'Override child two', agentType: 'copilot', useWorktree: true },
        ],
      },
    });
    expect(overrideRes.status()).toBe(201);
    const overrideGroup = await overrideRes.json() as TaskGroup;
    createdGroupIds.push(overrideGroup.id);
    expect(overrideGroup).toMatchObject({ priority: 'low', baseBranch: 'main' });
    expect(overrideGroup.children?.[0]).toMatchObject({ agentType: 'copilot', useWorktree: true });
  });
});

test.describe('Projects page', () => {
  const createdProjectIds: string[] = [];
  const createdTaskIds: string[] = [];
  const createdGroupIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdGroupIds) {
      await request.delete(`${API}/api/groups/${id}`).catch(() => {});
    }
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }

    for (const id of createdProjectIds) {
      await deleteProject(request, id);
    }
    createdProjectIds.length = 0;
    createdTaskIds.length = 0;
    createdGroupIds.length = 0;
  });

  test('creates a project card and uses its locked repo path when creating project tasks', async ({ page, request }) => {
    const repoPath = prepareTestRepo('projects-ui-card', { clean: true });
    const projectName = `Project UI ${Date.now()}`;
    let createdProjectId: string | undefined;

    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await page.getByRole('button', { name: 'New Project' }).click();
    await expect(page.getByRole('heading', { name: 'Create Project' })).toBeVisible();
    await page.getByLabel('Project Name').fill(projectName);
    await page.getByLabel('Local Path').fill(repoPath);
    await page.getByRole('button', { name: 'Create Project' }).click();
    const projectCard = page.getByRole('article', { name: projectName });
    await expect(projectCard).toBeVisible();

    const listRes = await request.get(`${API}/api/projects`);
    if (listRes.ok()) {
      const projects = await listRes.json() as Project[];
      const created = projects.find((project) => project.name === projectName);
      if (created) {
        createdProjectId = created.id;
        createdProjectIds.push(created.id);
      }
    }
    expect(createdProjectId).toBeTruthy();

    await expect(projectCard.getByText(repoPath)).toBeVisible();
    await expect(projectCard.getByText(/Backlog\s+0/i)).toBeVisible();
    await expect(projectCard.getByText(/In Progress\s+0/i)).toBeVisible();
    await expect(projectCard.getByText(/Review\s+0/i)).toBeVisible();
    await expect(projectCard.getByText(/Done\s+0/i)).toBeVisible();

    await projectCard.getByRole('button', { name: 'Open Project' }).click();
    await waitForBoard(page);
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

    await openNewTaskDialog(page);
    await expect(page.getByLabel(/Local Path/i)).toHaveValue(repoPath);
    const taskTitle = `Project UI Task ${Date.now()}`;
    await page.getByPlaceholder('What needs to be done?').fill(taskTitle);
    await page.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();

    const tasksRes = await request.get(`${API}/api/tasks?projectId=${createdProjectId}`);
    if (tasksRes.ok()) {
      const tasks = await tasksRes.json();
      for (const task of tasks) {
        if (task.title === taskTitle) {
          createdTaskIds.push(task.id);
          expect(task.repoPath).toBe(repoPath);
          expect(task.projectId).toBe(createdProjectId);
        }
      }
    }

    await page.goto('/projects');
    const updatedCard = page.getByRole('article', { name: projectName });
    await expect(updatedCard.getByText(/Backlog\s+1/i)).toBeVisible();
  });

  test('creates a project from the folder picker and validates selected paths', async ({ page, request }) => {
    const repoPath = prepareTestRepo('projects-ui-folder-picker', { clean: true });
    const projectName = `Picker Project ${Date.now()}`;
    let createdProjectId: string | undefined;

    await page.route('**/api/projects/select-directory', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ repoPath }),
      });
    });

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New Project' }).click();
    await expect(page.getByRole('heading', { name: 'Create Project' })).toBeVisible();
    await expect(page.getByLabel('Local Path')).toHaveValue('');
    await page.getByLabel('Project Name').fill(projectName);
    await page.getByRole('button', { name: 'Browse…' }).click();
    await expect(page.getByLabel('Local Path')).toHaveValue(repoPath);
    await expect(page.getByText('Local Path is valid')).toBeVisible();
    await page.getByRole('button', { name: 'Create Project' }).click();
    const projectCard = page.getByRole('article', { name: projectName });
    await expect(projectCard).toBeVisible();

    const listRes = await request.get(`${API}/api/projects`);
    if (listRes.ok()) {
      const projects = await listRes.json() as Project[];
      const created = projects.find((project) => project.name === projectName);
      if (created) {
        createdProjectId = created.id;
        createdProjectIds.push(created.id);
      }
    }
    expect(createdProjectId).toBeTruthy();
    await expect(projectCard.getByText(repoPath)).toBeVisible();
  });

  test('validates manually typed project paths before creating', async ({ page }) => {
    const projectName = `Invalid Path Project ${Date.now()}`;

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New Project' }).click();
    await page.getByLabel('Project Name').fill(projectName);
    await page.getByLabel('Local Path').fill('relative-project-path');
    await page.getByRole('button', { name: 'Create Project' }).click();

    await expect(page.getByText('Local Path must be absolute')).toBeVisible();
    await expect(page.getByText('Fix the Local Path before saving')).toBeVisible();
    await expect(page.getByRole('article', { name: projectName })).toHaveCount(0);
  });

  test('edits and deletes project cards from the projects page', async ({ page, request }) => {
    const originalRepoPath = prepareTestRepo('projects-ui-edit-original', { clean: true });
    const replacementRepoPath = prepareTestRepo('projects-ui-edit-replacement', { clean: true });
    const project = await createProject(request, {
      name: `Editable Project ${Date.now()}`,
      repoPath: originalRepoPath,
    });
    createdProjectIds.push(project.id);
    const updatedName = `${project.name} Renamed`;

    await page.goto('/projects');
    const projectCard = page.getByRole('article', { name: project.name });
    await expect(projectCard).toBeVisible();
    await projectCard.getByRole('button', { name: `Edit ${project.name}` }).click();
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();
    await expect(page.getByLabel('Local Path')).toHaveValue(originalRepoPath);
    await page.getByLabel('Project Name').fill(updatedName);
    await page.getByLabel('Local Path').fill(replacementRepoPath);
    await page.getByRole('button', { name: 'Save Changes' }).click();

    const updatedCard = page.getByRole('article', { name: updatedName });
    await expect(updatedCard).toBeVisible();
    await expect(updatedCard.getByText(replacementRepoPath)).toBeVisible();

    await updatedCard.getByRole('button', { name: `Delete ${updatedName}` }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete project?' });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('article', { name: updatedName })).toHaveCount(0);
  });

  test('does not offer deleting the seeded default project', async ({ page, request }) => {
    const defaultRes = await request.get(`${API}/api/projects/default`);
    expect(defaultRes.status()).toBe(200);
    const defaultProject = await defaultRes.json() as Project;

    await page.goto('/projects');
    const defaultCard = page.getByRole('article', { name: defaultProject.name });
    await expect(defaultCard).toBeVisible();
    await expect(defaultCard.getByRole('button', { name: `Delete ${defaultProject.name}` })).toHaveCount(0);
    await expect(defaultCard.getByRole('button', { name: `Edit ${defaultProject.name}` })).toBeVisible();
  });

  test('opens the seeded default project card with editable manual Local Path', async ({ page, request }) => {
    const defaultRes = await request.get(`${API}/api/projects/default`);
    expect(defaultRes.status()).toBe(200);
    const defaultProject = await defaultRes.json() as Project;
    expect(defaultProject.id).toBe('default');

    await page.goto('/projects');
    const defaultCard = page.getByRole('article', { name: defaultProject.name });
    await expect(defaultCard).toBeVisible();
    await defaultCard.getByRole('button', { name: 'Open Project' }).click();
    await waitForBoard(page);

    await openNewTaskDialog(page);
    const localPath = page.getByLabel(/Local Path/i);
    await expect(localPath).toBeEditable();
    await expect(localPath).toHaveValue('');
  });

  test('prefills the task dialog agent from the project default', async ({ page, request }) => {
    const repoPath = prepareTestRepo('projects-ui-default-agent', { clean: true });
    const project = await createProject(request, {
      name: `Default Agent Project ${Date.now()}`,
      repoPath,
      defaultAgentType: 'claude',
    });
    createdProjectIds.push(project.id);

    await page.goto('/projects');
    const projectCard = page.getByRole('article', { name: project.name });
    await expect(projectCard).toBeVisible();
    await projectCard.getByRole('button', { name: 'Open Project' }).click();
    await waitForBoard(page);

    await openNewTaskDialog(page);
    // Agent selector should default to the project's configured agent, not Copilot
    await expect(page.getByRole('dialog').getByRole('button', { name: /Claude/ })).toBeVisible();
  });

  test('persists project task defaults set through the project dialog', async ({ page, request }) => {
    const repoPath = prepareTestRepo('projects-ui-defaults-dialog', { clean: true });
    const projectName = `Defaults Dialog Project ${Date.now()}`;
    let createdProjectId: string | undefined;

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New Project' }).click();
    await expect(page.getByRole('heading', { name: 'Create Project' })).toBeVisible();
    await page.getByLabel('Project Name').fill(projectName);
    await page.getByLabel('Local Path').fill(repoPath);
    await page.getByLabel('Default Agent').selectOption('codex');
    await page.getByLabel('Default Priority').selectOption('high');
    await page.getByLabel('Default Base Branch').fill('develop');
    await page.getByLabel('Default Worktree').selectOption('true');
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByRole('article', { name: projectName })).toBeVisible();

    const listRes = await request.get(`${API}/api/projects`);
    expect(listRes.ok()).toBe(true);
    const projects = await listRes.json() as Project[];
    const created = projects.find((p) => p.name === projectName);
    expect(created).toBeTruthy();
    createdProjectId = created!.id;
    createdProjectIds.push(createdProjectId);

    expect(created).toMatchObject({
      defaultAgentType: 'codex',
      defaultPriority: 'high',
      defaultBaseBranch: 'develop',
      defaultUseWorktree: true,
    });
  });
});

test.describe('Projects config + repo-URL cloning', () => {
  const createdProjectIds: string[] = [];
  let originalCloneRoot: string | undefined;

  test.afterAll(async ({ request }) => {
    // Restore the original clone root so other suites are unaffected.
    if (originalCloneRoot) {
      await request.patch(`${API}/api/projects/config`, { data: { cloneRoot: originalCloneRoot } }).catch(() => {});
    }
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdProjectIds) {
      await deleteProject(request, id);
    }
    createdProjectIds.length = 0;
  });

  test('GET /api/projects/config returns a clone root', async ({ request }) => {
    const res = await request.get(`${API}/api/projects/config`);
    expect(res.status()).toBe(200);
    const config = await res.json() as { cloneRoot: string };
    expect(typeof config.cloneRoot).toBe('string');
    expect(config.cloneRoot.length).toBeGreaterThan(0);
    originalCloneRoot ??= config.cloneRoot;
  });

  test('PATCH /api/projects/config updates the clone root and rejects relative paths', async ({ request }) => {
    const current = await request.get(`${API}/api/projects/config`);
    const { cloneRoot } = await current.json() as { cloneRoot: string };
    originalCloneRoot ??= cloneRoot;

    const relativeRes = await request.patch(`${API}/api/projects/config`, { data: { cloneRoot: 'relative/clone/root' } });
    expect(relativeRes.status()).toBe(400);

    const emptyRes = await request.patch(`${API}/api/projects/config`, { data: { cloneRoot: '   ' } });
    expect(emptyRes.status()).toBe(400);

    // Set to a fresh absolute directory under test-results, then restore.
    const newRoot = path.resolve(process.cwd(), 'test-results', `clone-root-${Date.now()}`);
    const updateRes = await request.patch(`${API}/api/projects/config`, { data: { cloneRoot: newRoot } });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json() as { cloneRoot: string };
    expect(existsSync(updated.cloneRoot)).toBe(true);

    const restoreRes = await request.patch(`${API}/api/projects/config`, { data: { cloneRoot } });
    expect(restoreRes.status()).toBe(200);
    cleanupTestPath(newRoot);
  });

  test('POST /api/projects clones a repo from a URL and persists repoUrl', async ({ request }) => {
    const sourceRepo = prepareTestRepo('projects-clone-source', { clean: true });
    const configRes = await request.get(`${API}/api/projects/config`);
    const { cloneRoot } = await configRes.json() as { cloneRoot: string };
    originalCloneRoot ??= cloneRoot;

    const res = await request.post(`${API}/api/projects`, {
      data: { name: 'Cloned Repo Project', repoUrl: sourceRepo },
    });
    expect(res.status()).toBe(201);
    const project = await res.json() as Project;
    createdProjectIds.push(project.id);

    expect(project.repoUrl).toBe(sourceRepo);
    expect(project.repoPath).toBeTruthy();
    // The clone lands inside the configured clone root and is a real checkout.
    expect(existsSync(path.join(project.repoPath!, 'README.md'))).toBe(true);
    expect(existsSync(path.join(project.repoPath!, '.git'))).toBe(true);
  });

  test('POST /api/projects rejects providing both repoUrl and repoPath', async ({ request }) => {
    const sourceRepo = prepareTestRepo('projects-clone-conflict', { clean: true });
    const res = await request.post(`${API}/api/projects`, {
      data: { name: 'Conflict Project', repoUrl: sourceRepo, repoPath: sourceRepo },
    });
    expect(res.status()).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/either.*repoUrl.*repoPath|both/i) });
  });

  test('POST /api/projects reuses an existing clone of the same origin URL', async ({ request }) => {
    const sourceRepo = prepareTestRepo('projects-clone-reuse', { clean: true });

    const firstRes = await request.post(`${API}/api/projects`, {
      data: { name: 'Reuse Project A', repoUrl: sourceRepo },
    });
    expect(firstRes.status()).toBe(201);
    const first = await firstRes.json() as Project;
    createdProjectIds.push(first.id);

    const secondRes = await request.post(`${API}/api/projects`, {
      data: { name: 'Reuse Project B', repoUrl: sourceRepo },
    });
    expect(secondRes.status()).toBe(201);
    const second = await secondRes.json() as Project;
    createdProjectIds.push(second.id);

    // A matching-origin checkout is reused rather than re-cloned to a new dir.
    expect(second.repoPath).toBe(first.repoPath);
  });
});

test.describe('Projects creation via URI', () => {
  const createdProjectIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdProjectIds) {
      await deleteProject(request, id);
    }
    createdProjectIds.length = 0;
  });

  test('prefills the create dialog from query params without auto-submitting', async ({ page }) => {
    const projectName = `URI Prefill ${Date.now()}`;
    const repoUrl = 'https://github.com/owner/sample-repo.git';
    await page.goto(`/projects/new?source=repo&name=${encodeURIComponent(projectName)}&repoUrl=${encodeURIComponent(repoUrl)}`);

    await expect(page.getByRole('heading', { name: 'Create Project' })).toBeVisible();
    await expect(page.getByLabel('Project Name')).toHaveValue(projectName);
    await expect(page.getByLabel('Repository URL')).toHaveValue(repoUrl);
    // No project should have been created yet (prefill only).
    await expect(page.getByRole('article', { name: projectName })).toHaveCount(0);
  });

  test('auto-creates a project when autostart=1', async ({ page, request }) => {
    const sourceRepo = prepareTestRepo('projects-uri-autostart', { clean: true });
    const projectName = `URI Autostart ${Date.now()}`;
    await page.goto(
      `/projects/new?source=repo&name=${encodeURIComponent(projectName)}&repoUrl=${encodeURIComponent(sourceRepo)}&autostart=1`,
    );

    const projectCard = page.getByRole('article', { name: projectName });
    await expect(projectCard).toBeVisible({ timeout: 15_000 });

    const listRes = await request.get(`${API}/api/projects`);
    const projects = await listRes.json() as Project[];
    const created = projects.find((p) => p.name === projectName);
    expect(created).toBeTruthy();
    createdProjectIds.push(created!.id);
    expect(created!.repoUrl).toBe(sourceRepo);
  });
});
