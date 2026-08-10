import type { Task } from '../types.js';

const FALLBACK_AGENT_TIMEOUT_MS = 60 * 60 * 1000;

export function defaultAgentTimeoutMs(): number {
  const configured = Number.parseInt(process.env.AGENT_TIMEOUT_MS || '', 10);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : FALLBACK_AGENT_TIMEOUT_MS;
}

export function resolveTaskTimeoutMs(task: Pick<Task, 'timeoutMinutes'>): number {
  return task.timeoutMinutes == null
    ? defaultAgentTimeoutMs()
    : task.timeoutMinutes * 60 * 1000;
}