import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FolderKanban, GitBranch, Github, Pencil, Plus, Settings, Star, Trash2, X } from 'lucide-react';
import type { CreateProjectRequest, Project, ProjectPathValidation, ProviderConfig, RoleConfig, SettingsResponse, UpdateProjectRequest } from '@/types';
import { ThemeToggle } from './ThemeToggle';
import { ProjectDialog, type ProjectDialogInitialValues } from './ProjectDialog';
import { ConfigDialog } from './ConfigDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';

interface ProjectsPageProps {
  projects: Project[];
  settings: SettingsResponse | null;
  loading: boolean;
  error: string | null;
  initialCreate?: ProjectDialogInitialValues | null;
  onConsumeInitialCreate?: () => void;
  onClearError: () => void;
  onCreateProject: (data: CreateProjectRequest) => Promise<unknown>;
  onUpdateProject: (id: string, data: UpdateProjectRequest) => Promise<unknown>;
  onDeleteProject: (id: string) => Promise<unknown>;
  onUpdateProvider: (provider: ProviderConfig) => Promise<unknown>;
  onUpdateRole: (role: RoleConfig) => Promise<unknown>;
  onUpdateConfig: (cloneRoot: string) => Promise<unknown>;
  onTestProvider: (providerId: string, model: string) => Promise<{ available: boolean; model: string; version?: string; message?: string; error?: string } | undefined>;
  onValidateProjectPath: (repoPath: string) => Promise<ProjectPathValidation | undefined>;
  onSelectProjectDirectory: (initialPath?: string) => Promise<string | null | undefined>;
  onOpenProject: (project: Project) => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}

const countLabels: Array<[keyof NonNullable<Project['taskCounts']>, string]> = [
  ['backlog', 'Backlog'],
  ['in-progress', 'In Progress'],
  ['review', 'Review'],
  ['done', 'Done'],
];

export function ProjectsPage({
  projects,
  settings,
  loading,
  error,
  initialCreate,
  onConsumeInitialCreate,
  onClearError,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onUpdateProvider,
  onUpdateRole,
  onUpdateConfig,
  onTestProvider,
  onValidateProjectPath,
  onSelectProjectDirectory,
  onOpenProject,
  theme,
  toggleTheme,
}: ProjectsPageProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [createInitialValues, setCreateInitialValues] = useState<ProjectDialogInitialValues | null>(null);

  // Open the Create dialog prefilled when launched via a creation URI.
  useEffect(() => {
    if (initialCreate) {
      setEditingProject(null);
      setCreateInitialValues(initialCreate);
      setDialogOpen(true);
    }
  }, [initialCreate]);

  function openCreateDialog() {
    setEditingProject(null);
    setCreateInitialValues(null);
    setDialogOpen(true);
  }

  function openEditDialog(project: Project) {
    setEditingProject(project);
    setCreateInitialValues(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingProject(null);
    setCreateInitialValues(null);
    onConsumeInitialCreate?.();
  }

  async function handleDialogSubmit(data: CreateProjectRequest | UpdateProjectRequest) {
    if (editingProject) return onUpdateProject(editingProject.id, data);
    return onCreateProject(data as CreateProjectRequest);
  }

  async function handleConfirmDeleteProject() {
    if (!deletingProject) return;
    const result = await onDeleteProject(deletingProject.id);
    if (result !== undefined) setDeletingProject(null);
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="sticky top-0 z-40 border-b border-zinc-700/30 bg-zinc-900 shadow-md">
        <div className="flex h-14 items-center justify-between px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500">
              <FolderKanban className="h-4 w-4 text-white" />
            </div>
            <h1 className="truncate text-base font-semibold tracking-tight text-white md:text-lg">Projects</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openCreateDialog}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              aria-label="New Project"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Project</span>
            </button>
            <button
              onClick={() => setConfigOpen(true)}
              disabled={!settings}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-zinc-700/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Settings"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-5">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="max-w-3xl text-sm text-muted-foreground">
              Pick a Project to open a scoped board. Repo-backed Projects lock task Local Path to the Project path,
              while Default/no-repo Projects keep manual path entry available.
            </p>
          </div>

          {loading && (
            <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading projects…
            </div>
          )}

          {!loading && projects.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
              <h2 className="text-lg font-semibold">No projects yet</h2>
              <p className="mt-2 text-sm text-muted-foreground">Create a Project to start a scoped board.</p>
              <button
                onClick={openCreateDialog}
                className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                New Project
              </button>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <article
                key={project.id}
                aria-label={project.name}
                className="flex min-h-64 flex-col rounded-xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-semibold">{project.name}</h2>
                    {project.repoUrl && (
                      <p className="mt-2 flex items-center gap-1 break-all font-mono text-xs text-muted-foreground">
                        <Github className="h-3 w-3 shrink-0" />
                        {project.repoUrl}
                      </p>
                    )}
                    {project.repoPath ? (
                      <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{project.repoPath}</p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">Manual local paths per task</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {project.isDefault && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
                        <Star className="h-3 w-3" />
                        Default
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => openEditDialog(project)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Edit ${project.name}`}
                      title="Edit project"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    {!project.isDefault && (
                      <button
                        type="button"
                        onClick={() => setDeletingProject(project)}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                        aria-label={`Delete ${project.name}`}
                        title="Delete project"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-2">
                  {countLabels.map(([key, label]) => (
                    <div key={key} className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{label} {project.taskCounts?.[key] ?? 0}</span>
                        <span className="text-xl font-semibold" aria-hidden="true">{project.taskCounts?.[key] ?? 0}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => onOpenProject(project)}
                  className="mt-auto flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <GitBranch className="h-4 w-4" />
                  Open Project
                </button>
              </article>
            ))}
          </div>
        </div>
      </main>

      <ProjectDialog
        open={dialogOpen}
        project={editingProject}
        initialValues={createInitialValues}
        onClose={closeDialog}
        onSubmit={handleDialogSubmit}
        onValidatePath={onValidateProjectPath}
        onSelectDirectory={onSelectProjectDirectory}
      />

      <ConfigDialog
        open={configOpen}
        settings={settings}
        onClose={() => setConfigOpen(false)}
        onSaveCloneRoot={onUpdateConfig}
        onSaveProvider={onUpdateProvider}
        onSaveRole={onUpdateRole}
        onTestProvider={onTestProvider}
      />

      <DeleteConfirmDialog
        open={deletingProject !== null}
        taskTitle={deletingProject?.name ?? ''}
        title="Delete project?"
        description={(
          <p className="text-sm text-muted-foreground mb-5">
            <span className="font-medium text-foreground">{deletingProject?.name}</span> will be permanently
            deleted, along with all of its tasks and groups. This cannot be undone.
          </p>
        )}
        onCancel={() => setDeletingProject(null)}
        onConfirm={handleConfirmDeleteProject}
      />

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 shadow-lg backdrop-blur-sm"
          >
            <span>{error}</span>
            <button onClick={onClearError} className="ml-1 shrink-0 text-red-400 hover:text-red-300" aria-label="Dismiss error">
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
