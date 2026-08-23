import { useState, useCallback, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import type { Task, AgentType, Priority, ColumnId, Project } from '@/types';
import { useTheme } from '@/hooks/useTheme';
import { useTasks } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useDebounce } from '@/hooks/useDebounce';
import { useTaskGroups } from '@/hooks/useTaskGroups';
import { PRIORITY_WEIGHT } from '@/lib/priority-config';
import { slugify } from '@/lib/utils';
import { SK_SORT_BY, SK_SORT_DIR, SK_FILTER_AGENTS, SK_FILTER_STATUSES } from '@/lib/storage-keys';
import { Header } from '@/components/Header';
import type { StatusFilter } from '@/components/FilterChips';
import { statusFilterToStatuses } from '@/components/FilterChips';
import { Board } from '@/components/Board';
import { TaskDialog } from '@/components/TaskDialog';
import { TaskGroupDialog } from '@/components/TaskGroupDialog';
import { GroupPanel } from '@/components/GroupPanel';
import { AgentPanel } from '@/components/AgentPanel';
import type { TaskGroupWithChildren } from '@/lib/api';
import { DeleteConfirmDialog } from '@/components/DeleteConfirmDialog';
import { ProjectsPage } from '@/components/ProjectsPage';
import type { ProjectDialogInitialValues } from '@/components/ProjectDialog';

const STATUS_WEIGHT: Record<string, number> = { executing: 0, planning: 1, failed: 2, idle: 3, complete: 4 };

type TaskSubmitData = {
  title: string;
  description: string;
  priority: Priority;
  columnId: ColumnId;
  agentType: AgentType;
  autoRun?: boolean;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  timeoutMinutes?: number | null;
};

function BoardPage({
  project,
  theme,
  toggleTheme,
  onBackToProjects,
  initialTaskId,
}: {
  project: Project;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  onBackToProjects: () => void;
  initialTaskId?: string;
}) {
  const lockedRepoPath = project.repoPath;
  const projectDefaults = {
    defaultAgentType: project.defaultAgentType,
    defaultPriority: project.defaultPriority,
    defaultBaseBranch: project.defaultBaseBranch,
    defaultUseWorktree: project.defaultUseWorktree,
  };
  const { tasks, error, clearError, showArchived, setShowArchived, addTask, updateTask, moveTask, runTask, stopTask, deleteTask, archiveTask, unarchiveTask, configureAndRunTask, createPR, mergeLocal, cleanupWorktree } = useTasks(project.id);
  const { groups, createGroup, runGroup, stopGroup, deleteGroup, updateGroup, refreshGroup } = useTaskGroups(project.id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<TaskGroupWithChildren | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  useEffect(() => { if (initialTaskId) setSelectedTaskId(initialTaskId); }, [initialTaskId]);
  const [highlightRequiredFields, setHighlightRequiredFields] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'title' | 'priority' | 'created' | 'status'>(
    () => (localStorage.getItem(SK_SORT_BY) as 'title' | 'priority' | 'created' | 'status') || 'title'
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(
    () => (localStorage.getItem(SK_SORT_DIR) as 'asc' | 'desc') || 'asc'
  );
  const [activeAgentTypes, setActiveAgentTypes] = useState<AgentType[]>(
    () => { try { return JSON.parse(localStorage.getItem(SK_FILTER_AGENTS) || '[]'); } catch { return []; } }
  );
  const [activeStatuses, setActiveStatuses] = useState<StatusFilter[]>(
    () => { try { return JSON.parse(localStorage.getItem(SK_FILTER_STATUSES) || '[]'); } catch { return []; } }
  );

  // Debounce search query
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Persist sort preferences
  useEffect(() => {
    localStorage.setItem(SK_SORT_BY, sortBy);
    localStorage.setItem(SK_SORT_DIR, sortDir);
  }, [sortBy, sortDir]);

  // Persist filter preferences
  useEffect(() => {
    localStorage.setItem(SK_FILTER_AGENTS, JSON.stringify(activeAgentTypes));
    localStorage.setItem(SK_FILTER_STATUSES, JSON.stringify(activeStatuses));
  }, [activeAgentTypes, activeStatuses]);

  // Derive live task from tasks array so it stays current with WS updates
  const selectedTask = useMemo(
    () => {
      if (!selectedTaskId) return null;
      // Search standalone tasks first, then group children
      const standalone = tasks.find((t) => t.id === selectedTaskId);
      if (standalone) return standalone;
      for (const g of groups) {
        const child = g.children.find((c) => c.id === selectedTaskId);
        if (child) return child;
      }
      return null;
    },
    [selectedTaskId, tasks, groups]
  );

  const selectedGroup = useMemo(
    () => (selectedGroupId ? groups.find((g) => g.id === selectedGroupId) ?? null : null),
    [selectedGroupId, groups]
  );

  const handleClickGroup = useCallback((group: TaskGroupWithChildren) => {
    setSelectedGroupId(group.id);
    setSelectedTaskId(null);
  }, []);

  const handleDeleteGroup = useCallback((id: string) => {
    setDeletingGroupId(id);
  }, []);

  const handleEditGroup = useCallback((group: TaskGroupWithChildren) => {
    setEditingGroup(group);
    setGroupDialogOpen(true);
  }, []);

  const handleEditGroupSubmit = useCallback(async (id: string, updates: { title: string; description?: string; priority: Priority; maxConcurrency: number }) => {
    return updateGroup(id, updates);
  }, [updateGroup]);

  const handleRetryChild = useCallback(async (taskId: string) => {
    await runTask(taskId);
    if (selectedGroupId) refreshGroup(selectedGroupId);
  }, [runTask, selectedGroupId, refreshGroup]);

  const handleChildClick = useCallback((task: Task) => {
    setSelectedGroupId(null);
    setSelectedTaskId(task.id);
  }, []);

  // Filter tasks by search query, agent type, and status
  const filteredTasks = useMemo(() => {
    let result = tasks;

    // Text search
    if (debouncedSearchQuery.trim()) {
      const q = debouncedSearchQuery.toLowerCase();
      result = result.filter(
        (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      );
    }

    // Agent type filter (OR within group)
    if (activeAgentTypes.length > 0) {
      result = result.filter((t) => t.agentType && activeAgentTypes.includes(t.agentType));
    }

    // Status filter (OR within group) — "running" maps to planning|executing
    if (activeStatuses.length > 0) {
      const matchingStatuses = activeStatuses.flatMap(statusFilterToStatuses);
      result = result.filter((t) => matchingStatuses.includes(t.agentStatus));
    }

    return result;
  }, [tasks, debouncedSearchQuery, activeAgentTypes, activeStatuses]);

  // Sort comparator
  const sortTasks = useCallback((a: Task, b: Task): number => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortBy) {
      case 'title':
        return dir * a.title.localeCompare(b.title);
      case 'priority':
        return dir * ((PRIORITY_WEIGHT[a.priority] ?? 2) - (PRIORITY_WEIGHT[b.priority] ?? 2));
      case 'created':
        return dir * (a.createdAt - b.createdAt);
      case 'status':
        return dir * ((STATUS_WEIGHT[a.agentStatus] ?? 3) - (STATUS_WEIGHT[b.agentStatus] ?? 3));
      default:
        return 0;
    }
  }, [sortBy, sortDir]);

  const getFilteredTasksByColumn = useCallback(
    (columnId: ColumnId) => filteredTasks.filter((t) => t.columnId === columnId).sort(sortTasks),
    [filteredTasks, sortTasks]
  );

  const handleToggleAgentType = useCallback((agentType: AgentType) => {
    setActiveAgentTypes((prev) =>
      prev.includes(agentType) ? prev.filter((t) => t !== agentType) : [...prev, agentType]
    );
  }, []);

  const handleToggleStatus = useCallback((status: StatusFilter) => {
    setActiveStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]
    );
  }, []);

  const handleClearFilters = useCallback(() => {
    setActiveAgentTypes([]);
    setActiveStatuses([]);
  }, []);

  const handleTaskClick = useCallback((task: Task) => {
    if (task.columnId === 'backlog') return;
    setSelectedTaskId(task.id);
  }, []);

  const handleClosePanel = useCallback(() => {
    // If viewing a grouped child, return to its group panel
    if (selectedTaskId) {
      for (const g of groups) {
        if (g.children.some((c) => c.id === selectedTaskId)) {
          setSelectedTaskId(null);
          setSelectedGroupId(g.id);
          return;
        }
      }
    }
    setSelectedTaskId(null);
  }, [selectedTaskId, groups]);

  const handleOpenDialog = useCallback(() => {
    setDialogOpen(true);
  }, []);

  const handleOpenGroupDialog = useCallback(() => {
    setGroupDialogOpen(true);
  }, []);

  const handleCloseDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingTask(null);
    setHighlightRequiredFields(false);
  }, []);

  const handleEditTask = useCallback((task: Task) => {
    setEditingTask(task);
    setDialogOpen(true);
  }, []);

  const handleCreateTask = useCallback((task: TaskSubmitData) => {
    return addTask({
      ...task,
      projectId: project.id,
      repoPath: lockedRepoPath || task.repoPath,
    });
  }, [addTask, project.id, lockedRepoPath]);

  const handleCreateGroup = useCallback((group: Parameters<typeof createGroup>[0]) => {
    return createGroup({
      ...group,
      projectId: project.id,
      repoPath: lockedRepoPath || group.repoPath,
    });
  }, [createGroup, project.id, lockedRepoPath]);

  const handleDeleteTask = useCallback((task: Task) => {
    setDeletingTask(task);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (deletingTask) {
      deleteTask(deletingTask.id);
      setDeletingTask(null);
    } else if (deletingGroupId) {
      await deleteGroup(deletingGroupId);
      if (selectedGroupId === deletingGroupId) setSelectedGroupId(null);
      setDeletingGroupId(null);
    }
  }, [deletingTask, deleteTask, deletingGroupId, deleteGroup, selectedGroupId]);

  const handleCancelDelete = useCallback(() => {
    setDeletingTask(null);
    setDeletingGroupId(null);
  }, []);

  const handleArchiveTask = useCallback((task: Task) => {
    archiveTask(task.id);
  }, [archiveTask]);

  const handleUnarchiveTask = useCallback((task: Task) => {
    unarchiveTask(task.id);
  }, [unarchiveTask]);

  // Worktree dialog: intercept Run — if task has repoPath, run directly; otherwise open edit dialog
  const handleRunWithConfig = useCallback((taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (task.repoPath) {
      // Task already configured — run directly
      const wantWorktree = task.useWorktree ?? false;
      setSelectedTaskId(taskId);
      configureAndRunTask(taskId, {
        repoPath: task.repoPath,
        branchName: wantWorktree
          ? (task.branchName || `task/${slugify(task.title)}`)
          : '',
        baseBranch: task.baseBranch || 'main',
        useWorktree: wantWorktree,
        agentType: task.agentType,
      });
    } else {
      // Missing config — open edit dialog with required fields highlighted
      setEditingTask(task);
      setHighlightRequiredFields(true);
      setDialogOpen(true);
    }
  }, [tasks, configureAndRunTask]);

  const handleRetryTask = useCallback((task: Task) => {
    setSelectedTaskId(task.id);
    runTask(task.id);
  }, [runTask]);

  const handleReconfigureRetry = useCallback((taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    setEditingTask(task);
    setHighlightRequiredFields(true);
    setDialogOpen(true);
  }, [tasks]);

  // Keyboard shortcuts
  const handleCloseAll = useCallback(() => {
    if (deletingTask || deletingGroupId) {
      setDeletingTask(null);
      setDeletingGroupId(null);
    } else if (groupDialogOpen) {
      setGroupDialogOpen(false);
    } else if (dialogOpen) {
      setDialogOpen(false);
      setEditingTask(null);
      setHighlightRequiredFields(false);
    } else if (selectedGroupId) {
      setSelectedGroupId(null);
    } else if (selectedTaskId) {
      setSelectedTaskId(null);
    }
  }, [deletingTask, deletingGroupId, groupDialogOpen, dialogOpen, selectedGroupId, selectedTaskId]);

  const isAnyOpen = useCallback(
    () => dialogOpen || groupDialogOpen || selectedTaskId !== null || selectedGroupId !== null || deletingTask !== null || deletingGroupId !== null,
    [dialogOpen, groupDialogOpen, selectedTaskId, selectedGroupId, deletingTask, deletingGroupId]
  );

  useKeyboardShortcuts({
    onNewTask: handleOpenDialog,
    onNewGroup: handleOpenGroupDialog,
    onCloseAll: handleCloseAll,
    isAnyOpen,
  });

  // Auto-dismiss error toast
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 5000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Header
        title={project.name === 'Default' ? 'AI Agent Board' : project.name}
        onBackToProjects={onBackToProjects}
        theme={theme}
        toggleTheme={toggleTheme}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived(!showArchived)}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortByChange={setSortBy}
        onSortDirChange={setSortDir}
        activeAgentTypes={activeAgentTypes}
        activeStatuses={activeStatuses}
        onToggleAgentType={handleToggleAgentType}
        onToggleStatus={handleToggleStatus}
        onClearFilters={handleClearFilters}
        onNewTask={handleOpenDialog}
        onNewGroup={handleOpenGroupDialog}
      />

      <main className="flex-1 overflow-hidden">
        <Board
          tasks={filteredTasks}
          groups={groups}
          getTasksByColumn={getFilteredTasksByColumn}
          onMoveTask={moveTask}
          onTaskClick={handleTaskClick}
          onEditTask={handleEditTask}
          onDeleteTask={handleDeleteTask}
          onArchiveTask={handleArchiveTask}
          onUnarchiveTask={handleUnarchiveTask}
          onRetryTask={handleRetryTask}
          onAddTask={handleOpenDialog}
          showArchived={showArchived}
          onDropInProgress={(task) => setSelectedTaskId(task.id)}
          onClickGroup={handleClickGroup}
          onRunGroup={runGroup}
          onStopGroup={stopGroup}
          onDeleteGroup={handleDeleteGroup}
          onEditGroup={handleEditGroup}
        />
      </main>

      <TaskDialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        onSubmit={handleCreateTask}
        editTask={editingTask}
        onEditSubmit={updateTask}
        highlightRequired={highlightRequiredFields}
        lockedRepoPath={lockedRepoPath}
        projectDefaults={projectDefaults}
      />

      <TaskGroupDialog
        open={groupDialogOpen}
        onClose={() => { setGroupDialogOpen(false); setEditingGroup(null); }}
        onSubmit={handleCreateGroup}
        editGroup={editingGroup}
        onEditSubmit={handleEditGroupSubmit}
        lockedRepoPath={lockedRepoPath}
        projectDefaults={projectDefaults}
      />

      <AgentPanel task={selectedTask} onClose={handleClosePanel} onRun={handleRunWithConfig} onStop={stopTask} onCreatePR={createPR} onMergeLocal={mergeLocal} onCleanupWorktree={cleanupWorktree} onReconfigureRetry={handleReconfigureRetry} theme={theme} />

      <GroupPanel
        group={selectedGroup}
        onClose={() => setSelectedGroupId(null)}
        onRunGroup={runGroup}
        onStopGroup={stopGroup}
        onRetryChild={handleRetryChild}
        onChildClick={handleChildClick}
      />

      <DeleteConfirmDialog
        open={deletingTask !== null || deletingGroupId !== null}
        taskTitle={deletingTask?.title ?? groups.find(g => g.id === deletingGroupId)?.title ?? ''}
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />

      {/* Error toast */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 shadow-lg backdrop-blur-sm"
          >
            <span>{error}</span>
            <button onClick={clearError} className="ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded text-red-400 hover:bg-red-500/10 hover:text-red-300 lg:h-auto lg:w-auto">
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type RouteState =
  | { view: 'projects'; initialCreate?: ProjectDialogInitialValues }
  | { view: 'board'; projectId?: string; taskId?: string };

function parseCreateQuery(search: string): ProjectDialogInitialValues {
  const params = new URLSearchParams(search);
  const repoUrl = params.get('repoUrl') ?? undefined;
  const repoPath = params.get('repoPath') ?? undefined;
  const sourceParam = params.get('source');
  const source: 'local' | 'repo' =
    sourceParam === 'repo' || sourceParam === 'local'
      ? sourceParam
      : repoUrl
        ? 'repo'
        : 'local';
  const useWorktreeParam = params.get('defaultUseWorktree');
  const defaultUseWorktree =
    useWorktreeParam === 'true' || useWorktreeParam === 'false' || useWorktreeParam === 'inherit'
      ? (useWorktreeParam as 'true' | 'false' | 'inherit')
      : undefined;

  return {
    source,
    name: params.get('name') ?? undefined,
    repoUrl,
    repoPath,
    defaultAgentType: params.get('defaultAgentType') ?? undefined,
    defaultPriority: params.get('defaultPriority') ?? undefined,
    defaultBaseBranch: params.get('defaultBaseBranch') ?? undefined,
    defaultUseWorktree,
    autoSubmit: params.get('autostart') === '1',
  };
}

function readRoute(): RouteState {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/projects/new') {
    return { view: 'projects', initialCreate: parseCreateQuery(window.location.search) };
  }
  if (path === '/projects') return { view: 'projects' };
  const taskMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)$/);
  if (taskMatch) return { view: 'board', projectId: decodeURIComponent(taskMatch[1]), taskId: decodeURIComponent(taskMatch[2]) };
  const match = path.match(/^\/projects\/([^/]+)$/);
  if (match) return { view: 'board', projectId: decodeURIComponent(match[1]) };
  return { view: 'board' };
}

export function App() {
  const { theme, toggleTheme } = useTheme();
  const {
    projects,
    config,
    loading,
    error,
    clearError,
    createProject,
    updateProject,
    deleteProject,
    updateConfig,
    validateProjectPath,
    selectProjectDirectory,
  } = useProjects();
  const [route, setRoute] = useState<RouteState>(() => readRoute());

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(readRoute());
  }, []);

  const openProject = useCallback((project: Project) => {
    navigate(project.isDefault ? '/' : `/projects/${encodeURIComponent(project.id)}`);
  }, [navigate]);

  const defaultProject = useMemo(
    () => projects.find((project) => project.isDefault) ?? projects.find((project) => project.id === 'default') ?? projects[0],
    [projects],
  );

  const selectedProject = useMemo(() => {
    if (route.view !== 'board') return undefined;
    if (route.projectId) return projects.find((project) => project.id === route.projectId);
    return defaultProject;
  }, [defaultProject, projects, route]);

  if (route.view === 'projects' || (!loading && !selectedProject)) {
    return (
      <ProjectsPage
        projects={projects}
        config={config}
        loading={loading}
        error={error}
        initialCreate={route.view === 'projects' ? route.initialCreate ?? null : null}
        onConsumeInitialCreate={() => {
          if (route.view === 'projects' && route.initialCreate) navigate('/projects');
        }}
        onClearError={clearError}
        onCreateProject={createProject}
        onUpdateProject={updateProject}
        onDeleteProject={deleteProject}
        onUpdateConfig={updateConfig}
        onValidateProjectPath={validateProjectPath}
        onSelectProjectDirectory={selectProjectDirectory}
        onOpenProject={openProject}
        theme={theme}
        toggleTheme={toggleTheme}
      />
    );
  }

  if (loading || !selectedProject) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Loading project…
      </div>
    );
  }

  return (
    <BoardPage
      project={selectedProject}
      theme={theme}
      toggleTheme={toggleTheme}
      onBackToProjects={() => navigate('/projects')}
      initialTaskId={route.view === 'board' ? route.taskId : undefined}
    />
  );
}
