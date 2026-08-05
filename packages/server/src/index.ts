import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createWSS } from './websocket.js';
import { initDatabase, initPostgresDatabase, isPostgresUrl } from './db.js';
import { loadConfig } from './config.js';
import { SqliteTaskRepository } from './repositories/sqlite.js';
import { PostgresTaskRepository } from './repositories/postgres.js';
import { createTaskRouter } from './routes/tasks.js';
import { createAgentRouter } from './routes/agent.js';
import { createGitRouter } from './routes/git.js';
import { createTemplateRouter } from './routes/templates.js';
import { createGroupsRouter } from './routes/groups.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createProjectsRouter } from './routes/projects.js';
import type { AttachmentStore } from './repositories/attachment-types.js';
import { AgentManager } from './services/agent-manager.js';
import { authMiddleware } from './middleware/auth.js';
import type { TaskRepository } from './repositories/types.js';
import type { TemplateRepository } from './repositories/template-types.js';
import type { TaskGroupRepository } from './repositories/group-types.js';
import type { ProjectRepository } from './repositories/project-types.js';
import { isLoopbackAddress } from './network-policy.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST?.trim() || '127.0.0.1';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8081,http://localhost:4175,http://localhost:4176').split(',');
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '100kb' }));

// API key auth — when API_KEY env var is set, all /api routes require
// Authorization: Bearer <key>. When unset, auth is skipped (local dev).
app.use('/api', authMiddleware);

const DATABASE_URL = process.env.DATABASE_URL;

let taskRepo: TaskRepository;
let templateRepo: TemplateRepository;
let groupRepo: TaskGroupRepository;
let projectRepo: ProjectRepository;
let attachmentStore: AttachmentStore;
let cleanupDb: () => void;

// Initialize AgentManager
const agentManager = new AgentManager();

(async () => {
  // Load (and create on first run) the Agent Board config + clone root directory.
  const config = loadConfig();
  console.log(`[server] clone root: ${config.cloneRoot}`);

  if (isPostgresUrl(DATABASE_URL)) {
    // PostgreSQL backend
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DATABASE_URL });
    await initPostgresDatabase(pool);
    taskRepo = new PostgresTaskRepository(pool);
    const { PostgresProjectRepository } = await import('./repositories/postgres-projects.js');
    projectRepo = new PostgresProjectRepository(pool);
    const { PostgresTemplateRepository } = await import('./repositories/postgres-templates.js');
    templateRepo = new PostgresTemplateRepository(pool);
    const { PostgresTaskGroupRepository } = await import('./repositories/postgres-groups.js');
    groupRepo = new PostgresTaskGroupRepository(pool);
    const { PostgresAttachmentStore } = await import('./repositories/postgres-attachments.js');
    attachmentStore = new PostgresAttachmentStore(pool);
    cleanupDb = () => { pool.end(); };
    console.log('[server] using PostgreSQL backend');
  } else {
    // SQLite fallback
    const db = initDatabase();
    taskRepo = new SqliteTaskRepository(db);
    const { SqliteProjectRepository } = await import('./repositories/sqlite-projects.js');
    projectRepo = new SqliteProjectRepository(db);
    const { SqliteTemplateRepository } = await import('./repositories/sqlite-templates.js');
    templateRepo = new SqliteTemplateRepository(db);
    const { SqliteTaskGroupRepository } = await import('./repositories/sqlite-groups.js');
    groupRepo = new SqliteTaskGroupRepository(db);
    const { SqliteAttachmentStore } = await import('./repositories/sqlite-attachments.js');
    attachmentStore = new SqliteAttachmentStore(db);
    cleanupDb = () => { db.close(); };
    console.log('[server] using SQLite backend');
  }

  agentManager.initEventPersistence(taskRepo);
  agentManager.initAttachmentStore(attachmentStore);

  app.use('/api/projects', createProjectsRouter(projectRepo, taskRepo, groupRepo, agentManager));
  app.use('/api/tasks', createTaskRouter(taskRepo, agentManager, projectRepo));
  app.use('/api/tasks', createAgentRouter(taskRepo, agentManager, groupRepo, projectRepo));
  app.use('/api/tasks', createGitRouter(taskRepo, agentManager));
  app.use('/api/templates', createTemplateRouter(templateRepo));
  app.use('/api/groups', createGroupsRouter(groupRepo, taskRepo, agentManager, projectRepo));
  app.use('/api', createAttachmentsRouter(taskRepo, attachmentStore));

  // GET /api/agents — list available agents
  app.get('/api/agents', (_req, res) => {
    res.json(agentManager.getAvailableAgents());
  });

  // Health check (no auth required)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Global error handler — catches errors forwarded by asyncHandler wrappers
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] unhandled route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const server = createServer(app);
  createWSS(server);

  await agentManager.initialize();


  // Recover orphaned task groups first — group children get group-aware
  // recovery (planning → idle for re-queue, executing → failed) before the
  // generic fallback below resets everything to failed.
  const groupChildIds = new Set<string>();
  try {
    const allGroups = await groupRepo.getAll();
    for (const group of allGroups) {
      if (group.columnId === 'in-progress') {
        const children = await groupRepo.getChildTasks(group.id);
        for (const child of children) {
          groupChildIds.add(child.id);
          if (child.agentStatus === 'executing') {
            await taskRepo.update(child.id, { agentStatus: 'failed', completedAt: Date.now() });
            console.warn(`[server] recovered orphaned group child ${child.id} "${child.title}" (was executing)`);
          } else if (child.agentStatus === 'planning') {
            // Planning children hadn't started — reset to idle so they can be re-queued
            await taskRepo.update(child.id, { agentStatus: 'idle', startedAt: undefined });
            console.warn(`[server] reset group child ${child.id} "${child.title}" (was planning → idle)`);
          }
        }
        // Check if group should auto-advance after recovery
        const updatedChildren = await groupRepo.getChildTasks(group.id);
        const allDone = updatedChildren.every(c => c.agentStatus === 'complete' || c.agentStatus === 'failed');
        const anyFailed = updatedChildren.some(c => c.agentStatus === 'failed');
        if (allDone && !anyFailed) {
          await groupRepo.update(group.id, { columnId: 'review', completedAt: Date.now() });
          console.warn(`[server] recovered group ${group.id} "${group.title}" → review`);
        }
      }
    }
  } catch (err) {
    console.error('[server] failed to recover groups:', err);
  }

  // Recover standalone tasks orphaned by a previous server restart.
  // Skip group children (already handled above with group-aware recovery).
  const allTasks = await taskRepo.getAll();
  const orphaned = allTasks.filter(t =>
    (t.agentStatus === 'planning' || t.agentStatus === 'executing') && !groupChildIds.has(t.id)
  );
  for (const task of orphaned) {
    await taskRepo.update(task.id, {
      agentStatus: 'failed',
      completedAt: Date.now(),
    });
    console.warn(`[server] recovered orphaned task ${task.id} "${task.title}" (was ${task.agentStatus})`);
  }

  server.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] WebSocket at ws://${HOST}:${PORT}/ws`);
    if (process.env.API_KEY) {
      console.log('[server] API key authentication enabled');
    } else {
      console.warn('[server] WARNING: No API_KEY set — all endpoints are open without authentication.');
      console.warn('[server] Set the API_KEY environment variable to enable authentication.');
      if (!isLoopbackAddress(server.address())) {
        console.warn('[server] WARNING: effective bind address is not loopback while API_KEY is unset.');
      }
    }
  });

  // Graceful shutdown
  function shutdown() {
    console.log('[server] shutting down...');
    agentManager.shutdownAll();
    try { cleanupDb(); } catch (err) { console.error('[server] db cleanup error:', err); }
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.warn('[server] force exit after timeout');
      process.exit(1);
    }, 5_000).unref();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})();
