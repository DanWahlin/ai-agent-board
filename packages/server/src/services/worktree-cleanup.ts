import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';

export type WorktreeCleanupResult =
  | { status: 'removed' }
  | { status: 'missing' }
  | { status: 'blocked'; reason: string };

export type WorktreeCleanupInspection =
  | { status: 'ready'; device: number; inode: number }
  | Exclude<WorktreeCleanupResult, { status: 'removed' }>;

export interface WorktreeReconciliationReport {
  removed: string[];
  missing: string[];
  blocked: Array<{ path: string; reason: string }>;
}

interface RegisteredWorktree {
  path: string;
  branch?: string;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function listRegisteredWorktrees(repoPath: string): RegisteredWorktree[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: repoPath,
    stdio: 'pipe',
  }).toString();
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const field of output.split('\0')) {
    if (!field) {
      if (current) entries.push(current);
      current = undefined;
    } else if (field.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: field.slice('worktree '.length) };
    } else if (current && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function managedPathForTask(task: Task): boolean {
  if (!task.worktreePath || !path.isAbsolute(task.worktreePath)) return false;
  const resolved = path.resolve(task.worktreePath);
  let canonicalTemp: string;
  let canonicalParent: string;
  try {
    canonicalTemp = fs.realpathSync(os.tmpdir());
    canonicalParent = fs.realpathSync(path.dirname(resolved));
  } catch {
    return false;
  }
  return normalizedPath(canonicalParent) === normalizedPath(canonicalTemp)
    && path.basename(resolved) === path.basename(task.worktreePath)
    && new RegExp(`^agentboard-${task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[A-Za-z0-9]{6}$`).test(path.basename(resolved));
}

function managedOrphanPath(worktreePath: string): boolean {
  if (!path.isAbsolute(worktreePath)) return false;
  const resolved = path.resolve(worktreePath);
  let canonicalTemp: string;
  let canonicalParent: string;
  try {
    canonicalTemp = fs.realpathSync(os.tmpdir());
    canonicalParent = fs.realpathSync(path.dirname(resolved));
  } catch {
    return false;
  }
  return normalizedPath(canonicalParent) === normalizedPath(canonicalTemp)
    && /^agentboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9]{6}$/i.test(path.basename(resolved));
}

function isDisposableIgnoredPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  const name = parts[parts.length - 1] ?? '';
  return parts.includes('node_modules')
    || parts.includes('__pycache__')
    || parts.includes('.pytest_cache')
    || ['dist', 'coverage', 'test-results', 'playwright-report'].includes(name)
    || name.endsWith('.tsbuildinfo')
    || name.endsWith('.pyc');
}

export type WorktreeProcessUse = 'clear' | 'in-use' | 'unknown';

function processEntryDisappeared(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH');
}

export function inspectWorktreeProcessUse(
  worktreePath: string,
  platform = process.platform,
  procRoot = '/proc',
): WorktreeProcessUse {
  if (platform !== 'linux') return 'unknown';
  let processes: string[];
  try {
    processes = fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return 'unknown';
  }
  const root = fs.realpathSync(worktreePath);
  for (const pid of processes) {
    for (const link of [`${procRoot}/${pid}/cwd`, `${procRoot}/${pid}/exe`]) {
      try {
        if (isWithin(fs.realpathSync(link), root)) return 'in-use';
      } catch (error) {
        if (!processEntryDisappeared(error)) return 'unknown';
      }
    }
    let descriptors: string[];
    try {
      descriptors = fs.readdirSync(`${procRoot}/${pid}/fd`);
    } catch (error) {
      if (processEntryDisappeared(error)) continue;
      return 'unknown';
    }
    for (const descriptor of descriptors) {
      try {
        if (isWithin(fs.realpathSync(`${procRoot}/${pid}/fd/${descriptor}`), root)) return 'in-use';
      } catch (error) {
        if (!processEntryDisappeared(error)) return 'unknown';
      }
    }
  }
  return 'clear';
}

function inspectRegisteredPath(
  repoPath: string,
  worktreePath: string,
  expectedBranch?: string,
): WorktreeCleanupInspection {
  if (!expectedBranch) return { status: 'blocked', reason: 'Task has no branch to verify.' };
  const resolvedRepo = path.resolve(repoPath);
  const resolvedWorktree = path.resolve(worktreePath);
  if (normalizedPath(resolvedRepo) === normalizedPath(resolvedWorktree)) {
    return { status: 'blocked', reason: 'Refusing to remove the main repository checkout.' };
  }
  if (fs.existsSync(resolvedWorktree) && fs.lstatSync(resolvedWorktree).isSymbolicLink()) {
    return { status: 'blocked', reason: 'Refusing to remove a symbolic-link worktree path.' };
  }

  let registered: RegisteredWorktree[];
  try {
    registered = listRegisteredWorktrees(resolvedRepo);
  } catch {
    return { status: 'blocked', reason: 'Could not verify the worktree against its repository.' };
  }

  const matches = registered.filter((entry) => normalizedPath(entry.path) === normalizedPath(resolvedWorktree));
  if (matches.length === 0) {
    if (!fs.existsSync(resolvedWorktree)) return { status: 'missing' };
    return { status: 'blocked', reason: 'The directory is not registered as a worktree for this repository.' };
  }
  if (matches.length !== 1 || matches[0]?.branch !== expectedBranch) {
    return { status: 'blocked', reason: 'The registered worktree branch does not match the task branch.' };
  }
  if (!fs.existsSync(resolvedWorktree)) {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: resolvedRepo, stdio: 'pipe' }); } catch { /* best effort */ }
    return { status: 'missing' };
  }

  let before: fs.Stats;
  try {
    before = fs.lstatSync(resolvedWorktree);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('not a directory');
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedWorktree, stdio: 'pipe' }).toString().trim();
    const worktreeCommon = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: resolvedWorktree, stdio: 'pipe' }).toString().trim();
    const repoCommon = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: resolvedRepo, stdio: 'pipe' }).toString().trim();
    const branch = execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: resolvedWorktree, stdio: 'pipe' }).toString().trim();
    if (normalizedPath(topLevel) !== normalizedPath(fs.realpathSync(resolvedWorktree))
      || normalizedPath(worktreeCommon) !== normalizedPath(repoCommon)
      || branch !== `refs/heads/${expectedBranch}`) {
      return { status: 'blocked', reason: 'Worktree identity does not match the task repository and branch.' };
    }

    const records = execFileSync(
      'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
      { cwd: resolvedWorktree, stdio: 'pipe' },
    ).toString().split('\0').filter(Boolean);
    const unsafe = records.filter((record) => {
      const status = record.slice(0, 2);
      const filePath = record.slice(3);
      return status !== '!!' || !isDisposableIgnoredPath(filePath);
    });
    if (unsafe.length) {
      return { status: 'blocked', reason: 'Worktree has uncommitted, untracked, or non-disposable ignored files.' };
    }
    const processUse = inspectWorktreeProcessUse(resolvedWorktree);
    if (processUse === 'in-use') {
      return { status: 'blocked', reason: 'A running process is using the worktree.' };
    }
    if (processUse === 'unknown') {
      return { status: 'blocked', reason: 'Could not verify that no process is using the worktree.' };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'blocked', reason: `Could not safely verify the worktree: ${reason}` };
  }

  return { status: 'ready', device: before.dev, inode: before.ino };
}

function cleanupRegisteredPath(repoPath: string, worktreePath: string, expectedBranch?: string): WorktreeCleanupResult {
  const inspection = inspectRegisteredPath(repoPath, worktreePath, expectedBranch);
  if (inspection.status !== 'ready') return inspection;
  const resolvedWorktree = path.resolve(worktreePath);
  try {
    const current = fs.lstatSync(resolvedWorktree);
    if (current.dev !== inspection.device || current.ino !== inspection.inode || current.isSymbolicLink()) {
      return { status: 'blocked', reason: 'Worktree identity changed during cleanup verification.' };
    }
    execFileSync('git', ['worktree', 'remove', '--', resolvedWorktree], {
      cwd: path.resolve(repoPath),
      stdio: 'pipe',
    });
    return { status: 'removed' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'blocked', reason: `Git refused to remove the worktree: ${detail}` };
  }
}

/** Remove only a clean, registered worktree created by Agent Board. */
export function cleanupTaskWorktree(task: Task): WorktreeCleanupResult {
  if (!task.worktreePath || !task.repoPath) return { status: 'missing' };
  if (!managedPathForTask(task)) {
    return { status: 'blocked', reason: 'Refusing to remove a path outside the Board-managed worktree path.' };
  }
  return cleanupRegisteredPath(task.repoPath, task.worktreePath, task.branchName);
}

export function inspectTaskWorktree(task: Task): WorktreeCleanupInspection {
  if (!task.worktreePath || !task.repoPath) return { status: 'missing' };
  if (!managedPathForTask(task)) {
    return { status: 'blocked', reason: 'Refusing to remove a path outside the Board-managed worktree path.' };
  }
  return inspectRegisteredPath(task.repoPath, task.worktreePath, task.branchName);
}

export async function cleanupPersistedTaskWorktree(
  task: Task,
  repo: TaskRepository,
): Promise<{ task: Task; result: WorktreeCleanupResult }> {
  const result = cleanupTaskWorktree(task);
  if (result.status === 'blocked' || !task.worktreePath) return { task, result };
  const updated = await repo.update(task.id, { worktreePath: undefined });
  return { task: updated ?? { ...task, worktreePath: undefined }, result };
}

/** Repair terminal task worktrees and clean unreferenced, clean Board worktrees at startup. */
export async function reconcileManagedWorktrees(
  tasks: Task[],
  repoPaths: string[],
  repo: TaskRepository,
): Promise<WorktreeReconciliationReport> {
  const report: WorktreeReconciliationReport = { removed: [], missing: [], blocked: [] };
  const referencedPaths = new Set(
    tasks.flatMap((task) => task.worktreePath ? [normalizedPath(task.worktreePath)] : []),
  );

  for (const task of tasks) {
    if (!task.worktreePath || (task.columnId !== 'done' && !task.archived)) continue;
    const { result } = await cleanupPersistedTaskWorktree(task, repo);
    if (result.status === 'removed') report.removed.push(task.worktreePath);
    else if (result.status === 'missing') report.missing.push(task.worktreePath);
    else report.blocked.push({ path: task.worktreePath, reason: result.reason });
  }

  for (const repoPath of new Set(repoPaths.map((value) => path.resolve(value)))) {
    let registered: RegisteredWorktree[];
    try { registered = listRegisteredWorktrees(repoPath); } catch { continue; }
    for (const worktree of registered) {
      if (referencedPaths.has(normalizedPath(worktree.path)) || !managedOrphanPath(worktree.path)) continue;
      const result = cleanupRegisteredPath(repoPath, worktree.path, worktree.branch);
      if (result.status === 'removed') report.removed.push(worktree.path);
      else if (result.status === 'missing') report.missing.push(worktree.path);
      else report.blocked.push({ path: worktree.path, reason: result.reason });
    }
  }
  return report;
}
