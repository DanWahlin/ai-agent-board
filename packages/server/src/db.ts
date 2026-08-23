import Database from 'better-sqlite3';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';

// ─── SQLite ──────────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'agentboard.db');
const DATA_DIR = path.dirname(DB_PATH);

function migrate(db: Database.Database): void {
  const now = Date.now();

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      repo_path   TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, repo_path, is_default, created_at, updated_at)
    VALUES ('default', 'Default', NULL, 1, ?, ?)
  `).run(now, now);
  db.exec(`UPDATE projects SET is_default = CASE WHEN id = 'default' THEN 1 ELSE 0 END`);

  // Add project-level task default columns if they don't exist yet
  const projectCols = db.pragma('table_info(projects)') as { name: string }[];
  const projectColNames = new Set(projectCols.map((c) => c.name));
  if (!projectColNames.has('default_agent_type')) {
    db.exec(`ALTER TABLE projects ADD COLUMN default_agent_type TEXT`);
  }
  if (!projectColNames.has('default_priority')) {
    db.exec(`ALTER TABLE projects ADD COLUMN default_priority TEXT`);
  }
  if (!projectColNames.has('default_base_branch')) {
    db.exec(`ALTER TABLE projects ADD COLUMN default_base_branch TEXT`);
  }
  if (!projectColNames.has('default_use_worktree')) {
    db.exec(`ALTER TABLE projects ADD COLUMN default_use_worktree INTEGER`);
  }
  if (!projectColNames.has('repo_url')) {
    db.exec(`ALTER TABLE projects ADD COLUMN repo_url TEXT`);
  }
  if (!projectColNames.has('aliases')) db.exec(`ALTER TABLE projects ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      priority      TEXT NOT NULL DEFAULT 'medium',
      column_id     TEXT NOT NULL DEFAULT 'backlog',
      agent_status  TEXT NOT NULL DEFAULT 'idle',
      created_at    INTEGER NOT NULL,
      started_at    INTEGER,
      completed_at  INTEGER,
      summary       TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  INTEGER NOT NULL,
      metadata   TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  // Migrate existing events table to ON DELETE CASCADE if needed
  const fkList = db.pragma('foreign_key_list(events)') as Array<{ on_delete: string }>;
  const hasCascade = fkList.some((fk) => fk.on_delete === 'CASCADE');
  if (!hasCascade) {
    db.exec(`
      BEGIN;
      CREATE TABLE events_new (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL,
        type       TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  INTEGER NOT NULL,
        metadata   TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      INSERT INTO events_new SELECT * FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      COMMIT;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, timestamp ASC)`);
  }

  // Index for fast lookups by task_id + ordering by timestamp
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, timestamp ASC)`);

  // Add indexes for tasks table
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_column_id ON tasks(column_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_column_created ON tasks(column_id, created_at)`);

  // Add worktree columns if they don't exist yet
  const cols = db.pragma('table_info(tasks)') as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('repo_path')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN repo_path TEXT`);
  }
  if (!colNames.has('branch_name')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN branch_name TEXT`);
  }
  if (!colNames.has('base_branch')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN base_branch TEXT`);
  }
  if (!colNames.has('use_worktree')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN use_worktree INTEGER`);
  }
  if (!colNames.has('worktree_path')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT`);
  }
  if (!colNames.has('agent_type')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'copilot'`);
  }
  if (!colNames.has('archived')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }
  if (!colNames.has('project_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'`);
  }
  if (!colNames.has('group_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id) ON DELETE CASCADE`);
  }
  if (!colNames.has('group_order')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN group_order INTEGER`);
  }
  if (!colNames.has('summary')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN summary TEXT`);
  }
  if (!colNames.has('external_source')) db.exec(`ALTER TABLE tasks ADD COLUMN external_source TEXT`);
  if (!colNames.has('external_key')) db.exec(`ALTER TABLE tasks ADD COLUMN external_key TEXT`);
  if (!colNames.has('provenance')) db.exec(`ALTER TABLE tasks ADD COLUMN provenance TEXT`);
  if (!colNames.has('run_requested_at')) db.exec(`ALTER TABLE tasks ADD COLUMN run_requested_at INTEGER`);
  if (!colNames.has('run_claimed_at')) db.exec(`ALTER TABLE tasks ADD COLUMN run_claimed_at INTEGER`);
  if (!colNames.has('timeout_minutes')) db.exec(`ALTER TABLE tasks ADD COLUMN timeout_minutes INTEGER`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_identity ON tasks(external_source, external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL`);

  // Task groups table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_groups (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL DEFAULT 'default',
      title           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      priority        TEXT NOT NULL DEFAULT 'medium',
      column_id       TEXT NOT NULL DEFAULT 'backlog',
      repo_path       TEXT,
      base_branch     TEXT,
      max_concurrency INTEGER NOT NULL DEFAULT 2,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER,
      completed_at    INTEGER,
      archived        INTEGER NOT NULL DEFAULT 0
    )
  `);
  const groupCols = db.pragma('table_info(task_groups)') as { name: string }[];
  const groupColNames = new Set(groupCols.map((c) => c.name));
  if (!groupColNames.has('project_id')) {
    db.exec(`ALTER TABLE task_groups ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'`);
  }
  ensureSqliteProjectForeignKeys(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_relationships (
      task_id         TEXT NOT NULL,
      related_task_id TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'related' CHECK (type = 'related'),
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (task_id, related_task_id),
      CHECK (task_id < related_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (related_task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_relationships_related ON task_relationships(related_task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_column_id ON tasks(column_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_column_created ON tasks(column_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_group_id ON tasks(group_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_column ON tasks(project_id, archived, group_id, column_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_groups_project_column ON task_groups(project_id, archived, column_id)`);

  // Templates table
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      priority      TEXT NOT NULL DEFAULT 'medium',
      agent_type    TEXT NOT NULL DEFAULT 'copilot',
      repo_path     TEXT,
      base_branch   TEXT,
      use_worktree  INTEGER,
      created_at    INTEGER NOT NULL
    )
  `);

  // Task attachments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id ON task_attachments(task_id)`);
}

function hasSqliteForeignKey(
  db: Database.Database,
  table: string,
  fromColumn: string,
  referencedTable: string,
): boolean {
  const fkList = db.pragma(`foreign_key_list(${table})`) as Array<{ from: string; table: string }>;
  return fkList.some((fk) => fk.from === fromColumn && fk.table === referencedTable);
}

function ensureSqliteProjectForeignKeys(db: Database.Database): void {
  db.exec(`
    UPDATE tasks
    SET project_id = 'default'
    WHERE project_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = tasks.project_id);

    UPDATE task_groups
    SET project_id = 'default'
    WHERE project_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = task_groups.project_id);

    UPDATE tasks
    SET group_id = NULL, group_order = NULL
    WHERE group_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task_groups WHERE task_groups.id = tasks.group_id);
  `);

  const hasTaskProjectFk = hasSqliteForeignKey(db, 'tasks', 'project_id', 'projects');
  const hasTaskGroupFk = hasSqliteForeignKey(db, 'tasks', 'group_id', 'task_groups');
  const hasGroupProjectFk = hasSqliteForeignKey(db, 'task_groups', 'project_id', 'projects');
  if (hasTaskProjectFk && hasTaskGroupFk && hasGroupProjectFk) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;

      CREATE TABLE task_groups_new (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL DEFAULT 'default',
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        priority        TEXT NOT NULL DEFAULT 'medium',
        column_id       TEXT NOT NULL DEFAULT 'backlog',
        repo_path       TEXT,
        base_branch     TEXT,
        max_concurrency INTEGER NOT NULL DEFAULT 2,
        created_at      INTEGER NOT NULL,
        started_at      INTEGER,
        completed_at    INTEGER,
        archived        INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      INSERT INTO task_groups_new (
        id, project_id, title, description, priority, column_id, repo_path, base_branch,
        max_concurrency, created_at, started_at, completed_at, archived
      )
      SELECT
        id, project_id, title, description, priority, column_id, repo_path, base_branch,
        max_concurrency, created_at, started_at, completed_at, archived
      FROM task_groups;

      CREATE TABLE tasks_new (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        priority      TEXT NOT NULL DEFAULT 'medium',
        column_id     TEXT NOT NULL DEFAULT 'backlog',
        agent_status  TEXT NOT NULL DEFAULT 'idle',
        created_at    INTEGER NOT NULL,
        started_at    INTEGER,
        completed_at  INTEGER,
        repo_path     TEXT,
        branch_name   TEXT,
        base_branch   TEXT,
        use_worktree  INTEGER,
        worktree_path TEXT,
        agent_type    TEXT NOT NULL DEFAULT 'copilot',
        archived      INTEGER NOT NULL DEFAULT 0,
        project_id    TEXT NOT NULL DEFAULT 'default',
        group_id      TEXT,
        group_order   INTEGER,
        summary       TEXT,
        external_source TEXT,
        external_key TEXT,
        provenance TEXT,
        run_requested_at INTEGER,
        run_claimed_at INTEGER,
        timeout_minutes INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (group_id) REFERENCES task_groups(id) ON DELETE CASCADE
      );

      INSERT INTO tasks_new (
        id, title, description, priority, column_id, agent_status, created_at,
        started_at, completed_at, repo_path, branch_name, base_branch, use_worktree,
        worktree_path, agent_type, archived, project_id, group_id, group_order, summary,
        external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes
      )
      SELECT
        id, title, description, priority, column_id, agent_status, created_at,
        started_at, completed_at, repo_path, branch_name, base_branch, use_worktree,
        worktree_path, agent_type, archived, project_id, group_id, group_order, summary,
        external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes
      FROM tasks;

      DROP TABLE tasks;
      DROP TABLE task_groups;
      ALTER TABLE task_groups_new RENAME TO task_groups;
      ALTER TABLE tasks_new RENAME TO tasks;

      COMMIT;
    `);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error('SQLite foreign key migration failed integrity check');
  }
}

export function initDatabase(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000'); // wait up to 10s on lock contention
  migrate(db);
  console.log(`[db] initialized at ${DB_PATH}`);
  return db;
}

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

export async function initPostgresDatabase(pool: Pool): Promise<void> {
  const now = Date.now();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      repo_path   TEXT,
      is_default  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `);
  await pool.query(
    `INSERT INTO projects (id, name, repo_path, is_default, created_at, updated_at)
     VALUES ('default', 'Default', NULL, TRUE, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [now, now],
  );
  await pool.query(`UPDATE projects SET is_default = (id = 'default')`);

  // Add project-level task default columns if they don't exist yet
  const { rows: projectColRows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'projects' AND table_schema = current_schema()
  `);
  const projectColNames = new Set(projectColRows.map((r: { column_name: string }) => r.column_name));
  const addProjectCol = async (name: string, def: string) => {
    if (!projectColNames.has(name)) {
      await pool.query(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
    }
  };
  await addProjectCol('default_agent_type', 'TEXT');
  await addProjectCol('default_priority', 'TEXT');
  await addProjectCol('default_base_branch', 'TEXT');
  await addProjectCol('default_use_worktree', 'BOOLEAN');
  await addProjectCol('repo_url', 'TEXT');
  await addProjectCol('aliases', "TEXT NOT NULL DEFAULT '[]'");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      priority      TEXT NOT NULL DEFAULT 'medium',
      column_id     TEXT NOT NULL DEFAULT 'backlog',
      agent_status  TEXT NOT NULL DEFAULT 'idle',
      created_at    BIGINT NOT NULL,
      started_at    BIGINT,
      completed_at  BIGINT,
      repo_path     TEXT,
      branch_name   TEXT,
      base_branch   TEXT,
      use_worktree  BOOLEAN,
      worktree_path TEXT,
      agent_type    TEXT NOT NULL DEFAULT 'copilot',
      archived      BOOLEAN NOT NULL DEFAULT FALSE,
      project_id    TEXT NOT NULL DEFAULT 'default',
      timeout_minutes INTEGER
    )
  `);

  // Incremental column migrations — same pattern as SQLite migrate()
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks'
  `);
  const colNames = new Set(rows.map((r: { column_name: string }) => r.column_name));
  const addCol = async (name: string, def: string) => {
    if (!colNames.has(name)) {
      await pool.query(`ALTER TABLE tasks ADD COLUMN ${name} ${def}`);
    }
  };
  await addCol('repo_path', 'TEXT');
  await addCol('branch_name', 'TEXT');
  await addCol('base_branch', 'TEXT');
  await addCol('use_worktree', 'BOOLEAN');
  await addCol('worktree_path', 'TEXT');
  await addCol('agent_type', "TEXT NOT NULL DEFAULT 'copilot'");
  await addCol('archived', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addCol('project_id', "TEXT NOT NULL DEFAULT 'default'");
  await addCol('group_id', 'TEXT');
  await addCol('group_order', 'INTEGER');
  await addCol('summary', 'TEXT');
  await addCol('external_source', 'TEXT');
  await addCol('external_key', 'TEXT');
  await addCol('provenance', 'TEXT');
  await addCol('run_requested_at', 'BIGINT');
  await addCol('run_claimed_at', 'BIGINT');
  await addCol('timeout_minutes', 'INTEGER');
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_identity ON tasks(external_source, external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL`);

  // Task groups table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_groups (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL DEFAULT 'default',
      title           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      priority        TEXT NOT NULL DEFAULT 'medium',
      column_id       TEXT NOT NULL DEFAULT 'backlog',
      repo_path       TEXT,
      base_branch     TEXT,
      max_concurrency INTEGER NOT NULL DEFAULT 2,
      created_at      BIGINT NOT NULL,
      started_at      BIGINT,
      completed_at    BIGINT,
      archived        BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  const { rows: groupColRows } = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'task_groups'
  `);
  const groupColNames = new Set(groupColRows.map((r: { column_name: string }) => r.column_name));
  if (!groupColNames.has('project_id')) {
    await pool.query(`ALTER TABLE task_groups ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'`);
  }
  await pool.query(`
    UPDATE tasks
    SET project_id = 'default'
    WHERE project_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = tasks.project_id)
  `);
  await pool.query(`
    UPDATE task_groups
    SET project_id = 'default'
    WHERE project_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = task_groups.project_id)
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_group_id ON tasks(group_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_project_column ON tasks(project_id, archived, group_id, column_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_groups_project_column ON task_groups(project_id, archived, column_id)`);

  // Add FK for group_id if not present
  const { rows: gfkRows } = await pool.query(`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'tasks' AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'tasks_group_id_fkey'
  `);
  if (gfkRows.length === 0) {
    await pool.query(`
      ALTER TABLE tasks ADD CONSTRAINT tasks_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES task_groups(id) ON DELETE CASCADE
    `).catch(() => { /* constraint may already exist */ });
  }

  const { rows: pfkRows } = await pool.query(`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'tasks' AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'tasks_project_id_fkey'
  `);
  if (pfkRows.length === 0) {
    await pool.query(`
      ALTER TABLE tasks ADD CONSTRAINT tasks_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects(id)
    `).catch(() => { /* constraint may already exist or be blocked by existing data */ });
  }

  const { rows: gpfkRows } = await pool.query(`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'task_groups' AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'task_groups_project_id_fkey'
  `);
  if (gpfkRows.length === 0) {
    await pool.query(`
      ALTER TABLE task_groups ADD CONSTRAINT task_groups_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects(id)
    `).catch(() => { /* constraint may already exist or be blocked by existing data */ });
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_relationships (
      task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type            TEXT NOT NULL DEFAULT 'related' CHECK (type = 'related'),
      created_at      BIGINT NOT NULL,
      PRIMARY KEY (task_id, related_task_id),
      CHECK (task_id < related_task_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_relationships_related ON task_relationships(related_task_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  BIGINT NOT NULL,
      metadata   TEXT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, timestamp ASC)
  `);

  // Templates table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS templates (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      priority      TEXT NOT NULL DEFAULT 'medium',
      agent_type    TEXT NOT NULL DEFAULT 'copilot',
      repo_path     TEXT,
      base_branch   TEXT,
      use_worktree  BOOLEAN,
      created_at    BIGINT NOT NULL
    )
  `);

  // Task attachments table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      created_at    BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id ON task_attachments(task_id)`);

  // Migrate existing FK to ON DELETE CASCADE if not already set
  const { rows: fkRows } = await pool.query(`
    SELECT rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
    WHERE tc.table_name = 'events' AND tc.constraint_type = 'FOREIGN KEY'
  `);
  const hasCascade = fkRows.some((r: { delete_rule: string }) => r.delete_rule === 'CASCADE');
  if (!hasCascade) {
    await pool.query(`
      ALTER TABLE events
        DROP CONSTRAINT IF EXISTS events_task_id_fkey,
        ADD CONSTRAINT events_task_id_fkey
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    `);
  }
}

// ─── Backend selection helper ────────────────────────────────────────────────

export function isPostgresUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith('postgresql://') || url.startsWith('postgres://'));
}
