import { useCallback, useEffect, useState } from 'react';
import type { CreateProjectRequest, UpdateProjectRequest, Project, ProviderConfig, RoleConfig, SettingsResponse } from '@/types';
import { api, connectWS } from '@/lib/api';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      setError(null);
      const result = await api.getProjects();
      setProjects(result);
    } catch (err) {
      setError(`Failed to load projects: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch (err) {
      setError(`Failed to load settings: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
    refreshSettings();
  }, [refreshProjects, refreshSettings]);

  useEffect(() => {
    return connectWS((msg) => {
      if (msg.type === 'project_updated') {
        setProjects((prev) => {
          const exists = prev.some((project) => project.id === msg.payload.id);
          return exists
            ? prev.map((project) => (project.id === msg.payload.id ? msg.payload : project))
            : [...prev, msg.payload];
        });
      }
      if (
        msg.type === 'project_deleted' ||
        msg.type === 'task_updated' ||
        msg.type === 'task_deleted' ||
        msg.type === 'group_updated'
      ) {
        refreshProjects();
      }
    }, refreshProjects);
  }, [refreshProjects]);

  const createProject = useCallback(async (data: CreateProjectRequest) => {
    try {
      setError(null);
      const result = await api.createProject(data);
      await refreshProjects();
      return result;
    } catch (err) {
      setError(`Failed to create project: ${(err as Error).message}`);
      return undefined;
    }
  }, [refreshProjects]);

  const updateProject = useCallback(async (id: string, data: UpdateProjectRequest) => {
    try {
      setError(null);
      const result = await api.updateProject(id, data);
      await refreshProjects();
      return result;
    } catch (err) {
      setError(`Failed to update project: ${(err as Error).message}`);
      return undefined;
    }
  }, [refreshProjects]);

  const deleteProject = useCallback(async (id: string) => {
    try {
      setError(null);
      await api.deleteProject(id);
      await refreshProjects();
      return true;
    } catch (err) {
      setError(`Failed to delete project: ${(err as Error).message}`);
      return undefined;
    }
  }, [refreshProjects]);

  const validateProjectPath = useCallback(async (repoPath: string) => {
    try {
      setError(null);
      return await api.validateProjectPath(repoPath);
    } catch (err) {
      setError(`Failed to validate path: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const selectProjectDirectory = useCallback(async (initialPath?: string) => {
    try {
      setError(null);
      const result = await api.selectProjectDirectory(initialPath);
      return result.repoPath;
    } catch (err) {
      setError(`Failed to open folder picker: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const updateProvider = useCallback(async (provider: ProviderConfig) => {
    try {
      setError(null);
      const result = await api.updateProvider(provider.id, provider);
      setSettings(result);
      return result;
    } catch (err) {
      setError(`Failed to update provider: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const updateConfig = useCallback(async (cloneRoot: string) => {
    try {
      setError(null);
      const result = await api.updateProjectConfig(cloneRoot);
      setSettings(previous => previous ? { ...previous, cloneRoot: result.cloneRoot } : previous);
      return result;
    } catch (err) {
      setError(`Failed to update clone root: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const testProvider = useCallback(async (providerId: string, model: string) => {
    try {
      setError(null);
      return await api.testProvider(providerId, model);
    } catch (err) {
      setError(`Failed to test provider: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const updateRole = useCallback(async (role: RoleConfig) => {
    try {
      setError(null);
      const result = await api.updateRole(role.id, role);
      setSettings(result);
      return result;
    } catch (err) {
      setError(`Failed to update role: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    projects,
    settings,
    loading,
    error,
    clearError,
    refreshProjects,
    createProject,
    updateProject,
    deleteProject,
    validateProjectPath,
    selectProjectDirectory,
    updateProvider,
    updateRole,
    updateConfig,
    testProvider,
  };
}
