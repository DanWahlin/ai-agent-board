import type { Task, AgentEvent, TaskRelationship } from '../types.js';

export interface TaskRepository {
  getAll(includeArchived?: boolean, projectId?: string): Promise<Task[]>;
  getById(id: string): Promise<Task | undefined>;
  getByExternalIdentity(source: string, key: string): Promise<Task | undefined>;
  /** Resolve an exact id first, otherwise exact title matches in one project. */
  resolve(reference: string, projectId: string): Promise<Task[]>;
  create(task: Task): Promise<Task>;
  createIdempotent(task: Task): Promise<{ task: Task; created: boolean }>;
  requestRun(id: string, requestedAt: number): Promise<Task | undefined>;
  claimRun(id: string, claimedAt: number): Promise<Task | undefined>;
  clearRun(id: string): Promise<Task | undefined>;
  getPendingRuns(staleBefore?: number): Promise<Task[]>;
  update(id: string, updates: Partial<Task>): Promise<Task | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  insertEvent(event: AgentEvent): Promise<void>;
  getEventsByTaskId(taskId: string): Promise<AgentEvent[]>;
  deleteEventsByTaskId(taskId: string): Promise<void>;
  getArchivedTasks(projectId?: string): Promise<Task[]>;
  getRelationships(taskId: string): Promise<TaskRelationship[]>;
  createRelationship(taskId: string, relatedTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }>;
  deleteRelationship(taskId: string, relatedTaskId: string): Promise<boolean>;
}
