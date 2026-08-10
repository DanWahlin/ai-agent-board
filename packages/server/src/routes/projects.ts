import { Router, Request, Response } from 'express';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { AgentType, Priority } from '../types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import { broadcast } from '../websocket.js';
import { MAX_TITLE_LENGTH, isValidAgentType, isValidPriority } from '@ai-agent-board/shared/constants.js';
import { errorMessage } from '../utils.js';
import { getConfig, getCloneRoot, setCloneRoot } from '../config.js';
import {
  asyncHandler,
  broadcastProjectDelete,
  broadcastProjectUpdate,
  cloneRepo,
  expandTilde,
  getGitRemoteOrigin,
  isAllowedRepoPath,
  isGitWorkTree,
  isUnderAllowedRoots,
  isValidGitRef,
  normalizeRepoPathForCompare,
  normalizeRepoUrl,
  paramId,
  parseGitRepoUrl,
  validateRepoPath,
  type ParsedRepoUrl,
} from './helpers.js';

/** Error carrying an HTTP status, translated to a JSON response by the create handler. */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// Serialize clone operations per clone-root to avoid concurrent races on the same
// destination directory. Clones are infrequent, so a single chain per root is fine.
const cloneChains = new Map<string, Promise<unknown>>();
function withCloneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = cloneChains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  cloneChains.set(key, run.catch(() => undefined));
  return run;
}

function cloneErrorMessage(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e?.stderr ? e.stderr.toString().trim() : '';
  return stderr || e?.message || 'unknown error';
}

/** Clone into a temp dir then atomically rename, cleaning up on any failure. */
function cloneIntoTarget(url: string, target: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    cloneRepo(url, tmp);
  } catch (err: unknown) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new HttpError(400, `git clone failed: ${cloneErrorMessage(err)}`);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err: unknown) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new HttpError(500, `failed to finalize clone: ${errorMessage(err)}`);
  }
}

/**
 * Resolve a clone destination under the configured clone root and clone the repo
 * there. Reuses an existing checkout only when its `origin` matches the requested
 * URL; on a name collision with a different repo, falls back to a hash-suffixed
 * directory. Returns the resulting absolute repo path.
 */
function resolveAndCloneRepo(parsed: ParsedRepoUrl): string {
  const cloneRoot = getCloneRoot();
  fs.mkdirSync(cloneRoot, { recursive: true });
  const normalizedUrl = normalizeRepoUrl(parsed.url);
  const shortHash = crypto.createHash('sha1').update(normalizedUrl).digest('hex').slice(0, 8);
  const candidates = [parsed.name, `${parsed.name}-${shortHash}`];

  for (const candidateName of candidates) {
    const target = path.join(cloneRoot, candidateName);
    const boundaryErr = isUnderAllowedRoots(target);
    if (boundaryErr) throw new HttpError(400, boundaryErr);

    if (fs.existsSync(target)) {
      if (isGitWorkTree(target)) {
        const origin = getGitRemoteOrigin(target);
        if (origin && normalizeRepoUrl(origin) === normalizedUrl) {
          return fs.realpathSync(target);
        }
        continue; // different repo occupies this name
      }
      if (fs.readdirSync(target).length > 0) continue; // non-git, non-empty
      fs.rmdirSync(target); // empty dir — let git create it fresh
    }

    cloneIntoTarget(parsed.url, target);
    return fs.realpathSync(target);
  }

  throw new HttpError(
    409,
    `clone destination "${path.join(cloneRoot, parsed.name)}" is already in use by a different repository`,
  );
}

interface ParsedProjectDefaults {
  defaultAgentType?: AgentType | null;
  defaultPriority?: Priority | null;
  defaultBaseBranch?: string | null;
  defaultUseWorktree?: boolean | null;
}

/**
 * Validate and normalize the project-level task default fields from a request body.
 * When `allowNull` is true (PATCH), an explicit `null` clears a default and an empty
 * baseBranch string is treated as a clear. On create, empty/absent values are omitted.
 * Returns a parsed object, or a string error message.
 */
function parseProjectDefaults(body: Record<string, unknown>, allowNull: boolean): ParsedProjectDefaults | string {
  const out: ParsedProjectDefaults = {};

  if ('defaultAgentType' in body && body.defaultAgentType !== undefined) {
    const v = body.defaultAgentType;
    if (v === null) {
      if (!allowNull) return 'defaultAgentType must be a valid agent type';
      out.defaultAgentType = null;
    } else if (typeof v !== 'string' || !isValidAgentType(v)) {
      return 'defaultAgentType must be a valid agent type';
    } else {
      out.defaultAgentType = v;
    }
  }

  if ('defaultPriority' in body && body.defaultPriority !== undefined) {
    const v = body.defaultPriority;
    if (v === null) {
      if (!allowNull) return 'defaultPriority must be a valid priority';
      out.defaultPriority = null;
    } else if (typeof v !== 'string' || !isValidPriority(v)) {
      return 'defaultPriority must be a valid priority';
    } else {
      out.defaultPriority = v;
    }
  }

  if ('defaultBaseBranch' in body && body.defaultBaseBranch !== undefined) {
    const v = body.defaultBaseBranch;
    if (v === null) {
      if (allowNull) out.defaultBaseBranch = null;
    } else if (typeof v !== 'string') {
      return 'defaultBaseBranch must be a string';
    } else {
      const trimmed = v.trim();
      if (!trimmed) {
        if (allowNull) out.defaultBaseBranch = null;
      } else if (!isValidGitRef(trimmed)) {
        return 'defaultBaseBranch contains invalid characters';
      } else {
        out.defaultBaseBranch = trimmed;
      }
    }
  }

  if ('defaultUseWorktree' in body && body.defaultUseWorktree !== undefined) {
    const v = body.defaultUseWorktree;
    if (v === null) {
      if (allowNull) out.defaultUseWorktree = null;
    } else if (typeof v !== 'boolean') {
      return 'defaultUseWorktree must be a boolean';
    } else {
      out.defaultUseWorktree = v;
    }
  }

  return out;
}

export function createProjectsRouter(
  projectRepo: ProjectRepository,
  taskRepo: TaskRepository,
  groupRepo: TaskGroupRepository,
  agentManager: AgentManager,
): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.json(await projectRepo.getAllWithCounts());
  }));

  router.post('/validate-path', asyncHandler(async (req: Request, res: Response) => {
    const { repoPath } = req.body;
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      res.status(400).json({ error: 'repoPath must be a non-empty string' }); return;
    }

    res.json(validateRepoPath(repoPath.trim()));
  }));

  router.post('/select-directory', asyncHandler(async (req: Request, res: Response) => {
    const initialPath = typeof req.body.initialPath === 'string' && req.body.initialPath.trim()
      ? expandTilde(req.body.initialPath.trim())
      : undefined;
    try {
      const selected = selectDirectory(initialPath);
      res.json({ repoPath: selected });
    } catch (err: unknown) {
      res.status(501).json({ error: errorMessage(err) });
    }
  }));

  // GET /api/projects/config — current Agent Board config (e.g. clone root).
  // Declared before '/:id' so it is not captured by the id route.
  router.get('/config', asyncHandler(async (_req: Request, res: Response) => {
    res.json(getConfig());
  }));

  // PATCH /api/projects/config — update the clone root.
  router.patch('/config', asyncHandler(async (req: Request, res: Response) => {
    const { cloneRoot } = req.body;
    if (typeof cloneRoot !== 'string' || !cloneRoot.trim()) {
      res.status(400).json({ error: 'cloneRoot must be a non-empty string' }); return;
    }
    const expanded = expandTilde(cloneRoot.trim());
    if (!path.isAbsolute(expanded)) {
      res.status(400).json({ error: 'cloneRoot must be an absolute path' }); return;
    }
    try {
      res.json(setCloneRoot(expanded));
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }));

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const project = id === 'default' ? await projectRepo.getDefault() : await projectRepo.getById(id);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json(project);
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const { name, repoPath, repoUrl } = req.body;
    const aliases = parseAliases(req.body.aliases);
    if (typeof aliases === 'string') { res.status(400).json({ error: aliases }); return; }
    const projectName = typeof name === 'string' ? name.trim() : undefined;
    const hasRepoUrl = typeof repoUrl === 'string' && repoUrl.trim().length > 0;

    if (req.body.isDefault !== undefined) {
      res.status(400).json({ error: 'isDefault is immutable' }); return;
    }
    if (repoUrl !== undefined && typeof repoUrl !== 'string') {
      res.status(400).json({ error: 'repoUrl must be a string' }); return;
    }
    if (hasRepoUrl && typeof repoPath === 'string' && repoPath.trim()) {
      res.status(400).json({ error: 'provide either repoUrl or repoPath, not both' }); return;
    }
    if (!projectName && repoPath === undefined && !hasRepoUrl) {
      res.status(400).json({ error: 'name, repoPath, or repoUrl is required' }); return;
    }
    if (projectName !== undefined && !projectName) {
      res.status(400).json({ error: 'name must be a non-empty string' }); return;
    }
    if (projectName && projectName.length > MAX_TITLE_LENGTH) {
      res.status(400).json({ error: `name must be at most ${MAX_TITLE_LENGTH} characters` }); return;
    }
    if (repoPath !== undefined && typeof repoPath !== 'string') {
      res.status(400).json({ error: 'repoPath must be a string' }); return;
    }

    let expandedRepoPath: string | undefined;
    let storedRepoUrl: string | undefined;

    if (hasRepoUrl) {
      const parsed = parseGitRepoUrl(repoUrl.trim());
      if (typeof parsed === 'string') { res.status(400).json({ error: parsed }); return; }
      try {
        // Clone is the first step for a URL-backed project (serialized per clone root).
        expandedRepoPath = await withCloneLock(getCloneRoot(), async () => resolveAndCloneRepo(parsed));
        storedRepoUrl = parsed.url;
      } catch (err: unknown) {
        if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
        res.status(500).json({ error: errorMessage(err) }); return;
      }
    } else if (typeof repoPath === 'string') {
      expandedRepoPath = expandTilde(repoPath);
      if (!path.isAbsolute(expandedRepoPath)) {
        res.status(400).json({ error: 'repoPath must be an absolute path' }); return;
      }
      const repoErr = isAllowedRepoPath(expandedRepoPath);
      if (repoErr) { res.status(400).json({ error: repoErr }); return; }
    }

    const now = Date.now();
    const defaults = parseProjectDefaults(req.body, false);
    if (typeof defaults === 'string') { res.status(400).json({ error: defaults }); return; }

    const project = await projectRepo.create({
      id: uuid(),
      name: projectName || path.basename(path.resolve(expandedRepoPath as string)),
      repoPath: expandedRepoPath,
      repoUrl: storedRepoUrl,
      defaultAgentType: defaults.defaultAgentType ?? undefined,
      defaultPriority: defaults.defaultPriority ?? undefined,
      defaultBaseBranch: defaults.defaultBaseBranch ?? undefined,
      defaultUseWorktree: defaults.defaultUseWorktree ?? undefined, aliases,
      createdAt: now,
      updatedAt: now,
    });
    broadcastProjectUpdate(project);
    res.status(201).json(project);
  }));

  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (req.body.isDefault !== undefined) {
      res.status(400).json({ error: 'isDefault is immutable' }); return;
    }
    const existing = await projectRepo.getById(id);
    if (!existing) { res.status(404).json({ error: 'project not found' }); return; }

    const updates: {
      name?: string;
      repoPath?: string | null;
      repoUrl?: string | null;
      defaultAgentType?: AgentType | null;
      defaultPriority?: Priority | null;
      defaultBaseBranch?: string | null;
      defaultUseWorktree?: boolean | null;
      aliases?: string[];
      updatedAt: number;
    } = {
      updatedAt: Date.now(),
    };

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
        res.status(400).json({ error: 'name must be a non-empty string' }); return;
      }
      if (req.body.name.length > MAX_TITLE_LENGTH) {
        res.status(400).json({ error: `name must be at most ${MAX_TITLE_LENGTH} characters` }); return;
      }
      updates.name = req.body.name.trim();
    }

    if (req.body.repoPath !== undefined) {
      if (req.body.repoPath !== null && typeof req.body.repoPath !== 'string') {
        res.status(400).json({ error: 'repoPath must be a string or null' }); return;
      }
      if (typeof req.body.repoPath === 'string') {
        const expandedRepoPath = expandTilde(req.body.repoPath);
        if (!path.isAbsolute(expandedRepoPath)) {
          res.status(400).json({ error: 'repoPath must be an absolute path' }); return;
        }
        const changed = isRepoPathChange(existing.repoPath, expandedRepoPath);
        if (changed && await projectRepo.hasTasksOrGroups(id)) {
          res.status(409).json({ error: 'repoPath cannot be changed after tasks or groups exist' }); return;
        }
        if (!changed) {
          updates.repoPath = existing.repoPath;
        } else {
          const repoErr = isAllowedRepoPath(expandedRepoPath);
          if (repoErr) { res.status(400).json({ error: repoErr }); return; }
          updates.repoPath = expandedRepoPath;
        }
      } else {
        if (isRepoPathChange(existing.repoPath, null) && await projectRepo.hasTasksOrGroups(id)) {
          res.status(409).json({ error: 'repoPath cannot be cleared after tasks or groups exist' }); return;
        }
        updates.repoPath = null;
      }
    }

    // repoUrl is stored as metadata (the source URL); editing it does not re-clone.
    if (req.body.repoUrl !== undefined) {
      if (req.body.repoUrl !== null && typeof req.body.repoUrl !== 'string') {
        res.status(400).json({ error: 'repoUrl must be a string or null' }); return;
      }
      if (req.body.repoUrl === null) {
        updates.repoUrl = null;
      } else {
        const trimmed = req.body.repoUrl.trim();
        if (!trimmed) {
          updates.repoUrl = null;
        } else {
          const parsed = parseGitRepoUrl(trimmed);
          if (typeof parsed === 'string') { res.status(400).json({ error: parsed }); return; }
          updates.repoUrl = parsed.url;
        }
      }
    }

    const parsedDefaults = parseProjectDefaults(req.body, true);
    if (typeof parsedDefaults === 'string') { res.status(400).json({ error: parsedDefaults }); return; }
    Object.assign(updates, parsedDefaults);
    if (req.body.aliases !== undefined) { const aliases=parseAliases(req.body.aliases); if (typeof aliases === 'string') { res.status(400).json({error:aliases}); return; } updates.aliases=aliases; }

    const updated = await projectRepo.update(id, updates);
    if (!updated) { res.status(404).json({ error: 'project not found' }); return; }
    broadcastProjectUpdate(updated);
    res.json(updated);
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (id === 'default') { res.status(409).json({ error: 'the default project cannot be deleted' }); return; }
    const project = await projectRepo.getById(id);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }

    // Stop any running group queues + their agents before removing rows.
    const groups = await groupRepo.getAll(true, id);
    for (const group of groups) {
      await agentManager.stopGroup(group.id);
    }

    // Collect every task in the project: standalone tasks plus group children.
    const standaloneTasks = await taskRepo.getAll(true, id);
    const childTasks = (await Promise.all(groups.map((g) => groupRepo.getChildTasks(g.id)))).flat();
    const tasks = [...standaloneTasks, ...childTasks];

    // Stop agents, drop cached events, and clean up worktrees (best effort).
    for (const task of tasks) {
      await agentManager.stopAgent(task.id);
      agentManager.clearEvents(task.id);
      if (task.worktreePath) {
        try { agentManager.removeWorktree(task); } catch { /* best effort */ }
      }
    }

    const deleted = await projectRepo.delete(id);
    if (!deleted) { res.status(409).json({ error: 'project cannot be deleted' }); return; }

    for (const task of tasks) {
      broadcast({ type: 'task_deleted', payload: { id: task.id } });
    }
    broadcastProjectDelete(id);
    res.status(204).send();
  }));

  return router;
}

function parseAliases(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) return 'aliases must be an array of non-empty strings';
  const normalized=[...new Set(value.map(v => v.trim().toLowerCase()))];
  return normalized.length > 20 ? 'aliases cannot contain more than 20 values' : normalized;
}

function isRepoPathChange(existing: string | undefined, next: string | null): boolean {
  if (!existing && next === null) return false;
  if (!existing || next === null) return true;
  return normalizeRepoPathForCompare(existing) !== normalizeRepoPathForCompare(next);
}

function selectDirectory(initialPath?: string): string | null {
  if (process.platform === 'win32') return selectDirectoryWindows(initialPath);
  if (process.platform === 'darwin') return selectDirectoryMac();
  return selectDirectoryLinux(initialPath);
}

function selectDirectoryWindows(initialPath?: string): string | null {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select project folder'
$dialog.ShowNewFolderButton = $true
if ($env:AI_AGENT_BOARD_INITIAL_DIR -and [System.IO.Directory]::Exists($env:AI_AGENT_BOARD_INITIAL_DIR)) {
  $dialog.SelectedPath = $env:AI_AGENT_BOARD_INITIAL_DIR
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
  exit 0
}
exit 2
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, AI_AGENT_BOARD_INITIAL_DIR: initialPath ?? '' },
  });
  if (result.status === 0) return result.stdout.trim() || null;
  if (result.status === 2) return null;
  throw new Error(`Folder picker failed: ${result.stderr.trim() || result.error?.message || `exit ${result.status}`}`);
}

function selectDirectoryMac(): string | null {
  const result = spawnSync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select project folder")'], {
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim() || null;
  if (result.stderr.includes('User canceled')) return null;
  throw new Error(`Folder picker failed: ${result.stderr.trim() || result.error?.message || `exit ${result.status}`}`);
}

function selectDirectoryLinux(initialPath?: string): string | null {
  const commands: Array<{ command: string; args: string[] }> = [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=Select project folder'] },
    { command: 'kdialog', args: ['--getexistingdirectory', initialPath ?? '.'] },
  ];
  for (const { command, args } of commands) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    if (result.status === 0) return result.stdout.trim() || null;
    if (result.status === 1) return null;
    throw new Error(`Folder picker failed: ${result.stderr.trim() || errorMessage(result.error) || `exit ${result.status}`}`);
  }
  throw new Error('Folder picker is not available on this server. Install zenity or kdialog, or type the path manually.');
}
