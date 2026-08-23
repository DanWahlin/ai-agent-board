import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Kanban, Search, Archive, ArrowUpDown, Filter, Plus, X, Menu } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { FilterChips, type StatusFilter } from './FilterChips';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import type { AgentType } from '@/types';

type SortBy = 'title' | 'priority' | 'created' | 'status';
type SortDir = 'asc' | 'desc';

interface HeaderProps {
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  sortBy: SortBy;
  sortDir: SortDir;
  onSortByChange: (sortBy: SortBy) => void;
  onSortDirChange: (sortDir: SortDir) => void;
  activeAgentTypes: AgentType[];
  activeStatuses: StatusFilter[];
  onToggleAgentType: (agentType: AgentType) => void;
  onToggleStatus: (status: StatusFilter) => void;
  onClearFilters: () => void;
  onNewTask: () => void;
  onNewGroup: () => void;
  title?: string;
  onBackToProjects?: () => void;
}

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'priority', label: 'Priority' },
  { value: 'created', label: 'Created' },
  { value: 'status', label: 'Status' },
];

export function Header({ theme, toggleTheme, searchQuery, onSearchChange, showArchived, onToggleArchived, sortBy, sortDir, onSortByChange, onSortDirChange, activeAgentTypes, activeStatuses, onToggleAgentType, onToggleStatus, onClearFilters, onNewTask, onNewGroup, title = 'AI Agent Board', onBackToProjects }: HeaderProps) {
  const [showFilters, setShowFilters] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuSearchRef = useRef<HTMLInputElement>(null);
  const hasActiveFilters = activeAgentTypes.length > 0 || activeStatuses.length > 0;
  const { status: wsStatus, wasConnected } = useConnectionStatus();

  useEffect(() => {
    if (mobileMenuOpen) {
      mobileMenuSearchRef.current?.focus();
    }
  }, [mobileMenuOpen]);

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-700/30 bg-zinc-900 shadow-md">
      <div className="flex h-14 items-center justify-between gap-2 px-3 max-lg:pl-[max(0.75rem,env(safe-area-inset-left))] max-lg:pr-[max(0.75rem,env(safe-area-inset-right))] lg:px-6">
        {/* Logo + title */}
        <div className="flex min-w-0 items-center gap-2 lg:gap-3">
          {onBackToProjects && (
            <button
              onClick={onBackToProjects}
              className="flex h-11 shrink-0 items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white lg:h-8 lg:px-2"
              aria-label="Back to Projects"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Projects</span>
            </button>
          )}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500">
            <Kanban className="h-4 w-4 text-white" />
          </div>
          <h1 className="truncate text-base font-semibold tracking-tight text-white lg:text-lg">
            {title}
          </h1>
          <span className="hidden items-center gap-1 text-[10px] lg:flex">
            {wsStatus === 'connected' && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-emerald-500/70">Live</span>
              </>
            )}
            {wsStatus === 'disconnected' && wasConnected && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                <span className="text-red-400">Reconnecting…</span>
              </>
            )}
            {wsStatus === 'connecting' && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-amber-400/70">Connecting…</span>
              </>
            )}
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 lg:gap-0">
          {/* ── Desktop-only controls ── */}

          {/* Group 1: Create actions */}
          <div className="hidden lg:flex items-center gap-1.5">
            <button
              onClick={onNewTask}
              className="flex items-center gap-1.5 h-8 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors px-3"
              aria-label="New Task"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>New Task</span>
            </button>
            <button
              onClick={onNewGroup}
              className="flex items-center gap-1.5 h-8 rounded-lg border border-primary/50 text-primary text-xs font-medium hover:bg-primary/10 transition-colors px-3"
              aria-label="New Group"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>New Group</span>
            </button>
          </div>

          {/* Divider */}
          <div className="hidden lg:block mx-2.5 h-5 w-px bg-zinc-700" />

          {/* Group 2: Search */}
          <div className="relative hidden lg:block">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search tasks..."
              aria-label="Search tasks"
              className="h-8 w-48 rounded-lg border border-zinc-700 bg-zinc-800 pl-8 pr-3 text-xs text-zinc-200 placeholder:text-zinc-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>

          {/* Divider */}
          <div className="hidden lg:block mx-2.5 h-5 w-px bg-zinc-700" />

          {/* Group 3: View controls — filter, sort, archive */}
          <div className="hidden lg:flex items-center gap-1.5">
            {/* Filter toggle */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-1.5 h-8 rounded-lg border transition-colors text-xs font-medium px-3 ${
                showFilters || hasActiveFilters
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
              }`}
              aria-label="Toggle filters"
              title="Filter"
            >
              <Filter className="h-3.5 w-3.5 shrink-0" />
              {hasActiveFilters && <span>{activeAgentTypes.length + activeStatuses.length}</span>}
            </button>

            {/* Sort control — joined group */}
            <div className="flex items-center h-8 rounded-lg border border-zinc-700 bg-zinc-800 overflow-hidden">
              <div className="flex items-center gap-1.5 pl-2.5 pr-1 text-zinc-400">
                <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
              </div>
              <select
                value={sortBy}
                onChange={(e) => onSortByChange(e.target.value as SortBy)}
                className="h-full bg-transparent px-1 text-xs text-zinc-200 focus:outline-none cursor-pointer"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <button
                onClick={() => onSortDirChange(sortDir === 'asc' ? 'desc' : 'asc')}
                className="flex h-full w-7 items-center justify-center border-l border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                aria-label={`Sort ${sortDir === 'asc' ? 'descending' : 'ascending'}`}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            </div>

            {/* Archive toggle */}
            <button
              onClick={onToggleArchived}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
                showArchived
                  ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
              }`}
              aria-label={showArchived ? 'Hide Archived' : 'Show Archived'}
              title={showArchived ? 'Hide Archived' : 'Show Archived'}
            >
              <Archive className="h-3.5 w-3.5 shrink-0" />
            </button>
          </div>

          {/* Divider */}
          <div className="hidden lg:block mx-2.5 h-5 w-px bg-zinc-700" />

          <ThemeToggle theme={theme} toggleTheme={toggleTheme} />

          {/* ── Mobile hamburger ── */}
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            className={`flex h-11 w-11 items-center justify-center rounded-lg border transition-colors lg:hidden ${
              mobileMenuOpen || hasActiveFilters || showArchived
                ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
            }`}
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* ── Mobile expanded menu panel ── */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-zinc-700/40 bg-zinc-900 px-3 py-3 space-y-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              ref={mobileMenuSearchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search tasks..."
              aria-label="Search tasks"
              className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800 pl-8 pr-3 text-xs text-zinc-200 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>

          {/* New Task + New Group */}
          <div className="flex gap-2">
            <button
              onClick={() => { onNewTask(); setMobileMenuOpen(false); }}
              className="flex flex-1 items-center justify-center gap-1.5 h-11 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              New Task
            </button>
            <button
              onClick={() => { onNewGroup(); setMobileMenuOpen(false); }}
              className="flex flex-1 items-center justify-center gap-1.5 h-11 rounded-lg border border-primary/50 text-primary text-xs font-medium hover:bg-primary/10 transition-colors"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              New Group
            </button>
          </div>

          {/* Sort row */}
          <div className="flex items-center gap-2">
            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <span className="text-xs text-zinc-400">Sort</span>
            <select
              value={sortBy}
              onChange={(e) => onSortByChange(e.target.value as SortBy)}
              className="flex-1 h-11 rounded-lg border border-zinc-700 bg-zinc-800 px-2 text-xs text-zinc-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <button
              onClick={() => onSortDirChange(sortDir === 'asc' ? 'desc' : 'asc')}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
              aria-label={`Sort ${sortDir === 'asc' ? 'descending' : 'ascending'}`}
            >
              {sortDir === 'asc' ? '↑' : '↓'}
            </button>
          </div>

          {/* Filter + Archive row */}
          <div className="flex gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex flex-1 items-center justify-center gap-1.5 h-11 rounded-lg border transition-colors text-xs font-medium ${
                showFilters || hasActiveFilters
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
              }`}
              aria-label="Toggle filters"
            >
              <Filter className="h-3.5 w-3.5 shrink-0" />
              Filter{hasActiveFilters ? ` (${activeAgentTypes.length + activeStatuses.length})` : ''}
            </button>
            <button
              onClick={onToggleArchived}
              className={`flex flex-1 items-center justify-center gap-1.5 h-11 rounded-lg border transition-colors text-xs font-medium ${
                showArchived
                  ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
              }`}
              aria-label={showArchived ? 'Hide archived' : 'Show archived'}
            >
              <Archive className="h-3.5 w-3.5 shrink-0" />
              {showArchived ? 'Hide' : 'Show'} Archived
            </button>
          </div>

          {/* Filter chips (shown when filter is active) */}
          {showFilters && (
            <div className="flex items-center gap-2 flex-wrap pt-0.5">
              <FilterChips
                activeAgentTypes={activeAgentTypes}
                activeStatuses={activeStatuses}
                onToggleAgentType={onToggleAgentType}
                onToggleStatus={onToggleStatus}
                onClear={onClearFilters}
              />
            </div>
          )}
        </div>
      )}

      {/* Desktop filter chips row */}
      {showFilters && (
        <div className="hidden lg:flex items-center justify-end gap-2 px-6 pb-2">
          <FilterChips
            activeAgentTypes={activeAgentTypes}
            activeStatuses={activeStatuses}
            onToggleAgentType={onToggleAgentType}
            onToggleStatus={onToggleStatus}
            onClear={onClearFilters}
          />
        </div>
      )}
    </header>
  );
}
