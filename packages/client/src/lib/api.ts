import type {
  Task,
  TaskGroup,
  TaskAttachment,
  AgentEvent,
  AgentInfo,
  AgentType,
  ColumnId,
  Priority,
  WSMessage,
  Project,
  CreateProjectRequest,
  UpdateProjectRequest,
  ProjectPathValidation,
  ProjectConfig,
} from '@/types';

export interface TaskGroupWithChildren extends TaskGroup {
  children: Task[];
}

export interface CreateGroupChild {
  title: string;
  description?: string;
  agentType?: AgentType;
  useWorktree?: boolean;
}

function withQuery(path: string, params: Record<string, string | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

const BASE = '/api';
const API_KEY = import.meta.env.VITE_API_KEY as string | undefined;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }
  return headers;
}

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: authHeaders(),
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- Task CRUD ---

export const api = {
  // --- Projects ---
  getProjects: () =>
    request<Project[]>('/projects'),

  getProject: (id: string) =>
    request<Project>(`/projects/${encodeURIComponent(id)}`),

  getDefaultProject: () =>
    request<Project>('/projects/default'),

  createProject: (data: CreateProjectRequest) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),

  updateProject: (id: string, data: UpdateProjectRequest) =>
    request<Project>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteProject: (id: string) =>
    request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  validateProjectPath: (repoPath: string) =>
    request<ProjectPathValidation>('/projects/validate-path', { method: 'POST', body: JSON.stringify({ repoPath }) }),

  selectProjectDirectory: (initialPath?: string) =>
    request<{ repoPath: string | null }>('/projects/select-directory', { method: 'POST', body: JSON.stringify({ initialPath }) }),

  getProjectConfig: () =>
    request<ProjectConfig>('/projects/config'),

  updateProjectConfig: (cloneRoot: string) =>
    request<ProjectConfig>('/projects/config', { method: 'PATCH', body: JSON.stringify({ cloneRoot }) }),

  // --- Task CRUD ---
  getTasks: (includeArchived = false, projectId?: string) =>
    request<Task[]>(withQuery('/tasks', { includeArchived, projectId })),

  createTask: (data: { title: string; description?: string; priority?: Priority; columnId?: ColumnId; agentType?: AgentType; repoPath?: string; branchName?: string; baseBranch?: string; useWorktree?: boolean; autoRun?: boolean; projectId?: string; timeoutMinutes?: number }) =>
    request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),

  updateTask: (id: string, data: Partial<Task>) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteTask: (id: string) =>
    request<void>(`/tasks/${id}`, { method: 'DELETE' }),

  runTask: (id: string) =>
    request<Task>(`/tasks/${id}/run`, { method: 'POST' }),

  stopTask: (id: string) =>
    request<Task>(`/tasks/${id}/stop`, { method: 'POST' }),

  getEvents: (id: string) =>
    request<AgentEvent[]>(`/tasks/${id}/events`),

  getAgents: () => request<AgentInfo[]>('/agents'),

  configureTask: (id: string, config: { repoPath: string; branchName: string; baseBranch: string; useWorktree: boolean; agentType?: AgentType }) =>
    request<Task>(`/tasks/${id}/configure`, { method: 'POST', body: JSON.stringify(config) }),

  createPR: (id: string) =>
    request<{ url: string }>(`/tasks/${id}/create-pr`, { method: 'POST' }),

  cleanupWorktree: (id: string) =>
    request<{ success: boolean }>(`/tasks/${id}/cleanup-worktree`, { method: 'POST' }),

  mergeLocal: (id: string) =>
    request<{ merged: boolean; baseBranch: string }>(`/tasks/${id}/merge-local`, { method: 'POST' }),

  getGitInfo: (id: string) =>
    request<{ hasRemote: boolean }>(`/tasks/${id}/git-info`),

  sendMessage: (id: string, message: string, attachmentIds?: string[]) =>
    request<{ success: boolean }>(`/tasks/${id}/message`, { method: 'POST', body: JSON.stringify({ message, attachmentIds }) }),

  // --- Attachments ---
  uploadAttachments: async (taskId: string, files: File[]): Promise<TaskAttachment[]> => {
    const form = new FormData();
    for (const f of files) form.append('images', f);
    const headers: Record<string, string> = {};
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
    const res = await fetch(`${BASE}/tasks/${taskId}/attachments`, { method: 'POST', headers, body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed (HTTP ${res.status})`);
    }
    return res.json();
  },

  getAttachments: (taskId: string) =>
    request<TaskAttachment[]>(`/tasks/${taskId}/attachments`),

  deleteAttachment: (id: string) =>
    request<void>(`/attachments/${id}`, { method: 'DELETE' }),

  getAttachmentUrl: (id: string) => `${BASE}/attachments/${id}/file`,

  archiveTask: (id: string) =>
    request<Task>(`/tasks/${id}/archive`, { method: 'PATCH' }),

  unarchiveTask: (id: string) =>
    request<Task>(`/tasks/${id}/unarchive`, { method: 'PATCH' }),

  // --- Groups ---
  getGroups: (includeArchived = false, projectId?: string) =>
    request<TaskGroupWithChildren[]>(withQuery('/groups', { archived: includeArchived, projectId })),

  getGroup: (id: string) =>
    request<TaskGroupWithChildren>(`/groups/${id}`),

  createGroup: (data: {
    title: string;
    description?: string;
    priority?: Priority;
    repoPath?: string;
    baseBranch?: string;
    maxConcurrency: number;
    children: CreateGroupChild[];
    autoRun?: boolean;
    projectId?: string;
  }) => request<TaskGroupWithChildren>('/groups', { method: 'POST', body: JSON.stringify(data) }),

  updateGroup: (id: string, data: Partial<TaskGroup>) =>
    request<TaskGroupWithChildren>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteGroup: (id: string) =>
    request<void>(`/groups/${id}`, { method: 'DELETE' }),

  runGroup: (id: string) =>
    request<TaskGroupWithChildren>(`/groups/${id}/run`, { method: 'POST' }),

  stopGroup: (id: string) =>
    request<{ stopped: boolean }>(`/groups/${id}/stop`, { method: 'POST' }),

};

// --- WebSocket (shared singleton) ---

export type WSMessageHandler = (msg: WSMessage) => void;
type ReconnectHandler = () => void;

const listeners = new Set<WSMessageHandler>();
const reconnectListeners = new Set<ReconnectHandler>();
let ws: WebSocket | null = null;
let disposed = false;
let reconnectTimer: ReturnType<typeof setTimeout>;

// Connection status tracking
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';
let connectionStatus: ConnectionStatus = 'connecting';
let hasConnectedOnce = false;
const statusListeners = new Set<(status: ConnectionStatus) => void>();

function setConnectionStatus(status: ConnectionStatus) {
  if (status === 'connected') hasConnectedOnce = true;
  connectionStatus = status;
  statusListeners.forEach((fn) => fn(status));
}

export function getConnectionStatus(): ConnectionStatus {
  return connectionStatus;
}

/** Returns true only after a successful connection has been made at least once */
export function hasEverConnected(): boolean {
  return hasConnectedOnce;
}

export function subscribeConnectionStatus(listener: (status: ConnectionStatus) => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

function ensureConnection() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${location.host}/ws`;
  if (API_KEY) {
    url += `?token=${encodeURIComponent(API_KEY)}`;
  }
  disposed = false;
  setConnectionStatus('connecting');

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] connected');
    setConnectionStatus('connected');
    reconnectListeners.forEach((fn) => {
      try { fn(); } catch (err) { console.error('[WS] reconnect listener error:', err); }
    });
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as WSMessage;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      listeners.forEach((fn) => fn(msg));
    } catch { /* ignore malformed messages */ }
  };

  ws.onclose = () => {
    if (!disposed && listeners.size > 0) {
      console.log('[WS] disconnected, reconnecting in 2s');
      setConnectionStatus('disconnected');
      reconnectTimer = setTimeout(ensureConnection, 2000);
    } else {
      setConnectionStatus('disconnected');
    }
  };

  ws.onerror = () => ws?.close();
}

/**
 * Subscribe to WebSocket messages. Returns an unsubscribe function.
 * All callers share a single underlying connection.
 * onReconnect is called after each reconnect so callers can re-fetch state.
 */
export function connectWS(onMessage: WSMessageHandler, onReconnect?: ReconnectHandler): () => void {
  listeners.add(onMessage);
  if (onReconnect) reconnectListeners.add(onReconnect);
  ensureConnection();

  return () => {
    listeners.delete(onMessage);
    if (onReconnect) reconnectListeners.delete(onReconnect);
    if (listeners.size === 0) {
      disposed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    }
  };
}
