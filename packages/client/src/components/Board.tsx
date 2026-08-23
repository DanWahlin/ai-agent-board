import { useCallback, useState, useMemo, useRef, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  DragStartEvent,
  DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  CollisionDetection,
} from '@dnd-kit/core';
import { motion } from 'framer-motion';
import type { Task, ColumnId, Column as ColumnType } from '@/types';
import { VALID_TRANSITIONS } from '@/types';
import { columns as baseColumns } from '@/lib/columns';
import { Column } from './Column';
import { TaskCard } from './TaskCard';
import { TaskGroupCard } from './TaskGroupCard';
import type { TaskGroupWithChildren } from '@/lib/api';
import { cn } from '@/lib/utils';


interface BoardProps {
  tasks: Task[];
  groups?: TaskGroupWithChildren[];
  getTasksByColumn: (columnId: ColumnId) => Task[];
  onMoveTask: (taskId: string, targetColumn: ColumnId) => void;
  onTaskClick: (task: Task) => void;
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (task: Task) => void;
  onArchiveTask?: (task: Task) => void;
  onUnarchiveTask?: (task: Task) => void;
  onRetryTask?: (task: Task) => void;
  onAddTask: () => void;
  onDropInProgress?: (task: Task) => void;
  showArchived?: boolean;
  onClickGroup?: (group: TaskGroupWithChildren) => void;
  onRunGroup?: (id: string) => void;
  onStopGroup?: (id: string) => void;
  onDeleteGroup?: (id: string) => void;
  onEditGroup?: (group: TaskGroupWithChildren) => void;
}

// Use pointerWithin first (ideal for dropping into columns),
// fall back to rectIntersection if pointer isn't inside any droppable.
const kanbanCollision: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return rectIntersection(args);
};

export function Board({
  tasks,
  groups = [],
  getTasksByColumn,
  onMoveTask,
  onTaskClick,
  onEditTask,
  onDeleteTask,
  onArchiveTask,
  onUnarchiveTask,
  onRetryTask,
  onAddTask,
  onDropInProgress,
  showArchived = false,
  onClickGroup,
  onRunGroup,
  onStopGroup,
  onDeleteGroup,
  onEditGroup,
}: BoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  // Dynamically add archived column when showArchived is true
  const columns = useMemo(() => {
    if (!showArchived) return baseColumns;

    return [
      ...baseColumns,
      {
        id: 'archived' as ColumnId,
        title: 'Archived',
        color: 'bg-zinc-500',
        icon: 'archive'
      } as ColumnType
    ];
  }, [showArchived]);

  const getTasksForColumn = useCallback((columnId: ColumnId | string) => {
    if (columnId === 'archived') {
      return tasks.filter(t => t.archived === true);
    }
    return getTasksByColumn(columnId as ColumnId);
  }, [tasks, getTasksByColumn]);

  const getGroupsForColumn = useCallback((columnId: ColumnId | string) => {
    return groups.filter(g => g.columnId === columnId && !g.archived);
  }, [groups]);

  // Mouse: small distance threshold keeps desktop drag/drop snappy.
  // Touch: require a deliberate press-and-hold before a drag starts so
  // horizontal rail swipes and vertical column pans never grab a card.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    })
  );

  // ── Mobile horizontal rail state (scroll snap + position affordance) ──
  const railRef = useRef<HTMLDivElement>(null);
  const [activeColumn, setActiveColumn] = useState(0);

  const updateActiveColumn = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const children = Array.from(rail.children) as HTMLElement[];
    if (children.length === 0) return;
    const maxScroll = rail.scrollWidth - rail.clientWidth;
    // At either physical edge, report the edge column rather than whichever
    // card happens to sit under the viewport center on wide phone landscapes.
    if (rail.scrollLeft <= 1) {
      setActiveColumn(0);
      return;
    }
    if (maxScroll > 0 && rail.scrollLeft >= maxScroll - 1) {
      setActiveColumn(children.length - 1);
      return;
    }
    const railCenter = rail.scrollLeft + rail.clientWidth / 2;
    let nearest = 0;
    let nearestDist = Infinity;
    children.forEach((child, i) => {
      const childCenter = child.offsetLeft + child.offsetWidth / 2;
      const dist = Math.abs(childCenter - railCenter);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setActiveColumn(nearest);
  }, []);

  useEffect(() => {
    updateActiveColumn();
    window.addEventListener('resize', updateActiveColumn);
    return () => window.removeEventListener('resize', updateActiveColumn);
  }, [updateActiveColumn, columns.length]);

  const scrollToColumn = useCallback((index: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const target = rail.children[index] as HTMLElement | undefined;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = tasks.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
      document.body.style.cursor = 'grabbing';
    },
    [tasks]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      document.body.style.cursor = '';
      setActiveTask(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const overId = over.id as string;
      const draggedTask = tasks.find((t) => t.id === taskId);
      if (!draggedTask) return;

      // Resolve target column
      const isColumn = columns.some((c) => c.id === overId);
      let targetColumn: ColumnId;
      if (isColumn) {
        targetColumn = overId as ColumnId;
      } else {
        const overTask = tasks.find((t) => t.id === overId);
        if (!overTask) return;
        targetColumn = overTask.columnId;
      }

      // Don't allow moving archived tasks
      if (draggedTask.archived) return;

      // Don't allow dropping into archived column
      if ((targetColumn as string) === 'archived') return;

      // Validate transition before moving
      if (targetColumn === draggedTask.columnId) return;
      if (!VALID_TRANSITIONS[draggedTask.columnId]?.includes(targetColumn)) return;

      onMoveTask(taskId, targetColumn);

      // Auto-open agent panel when dropped into in-progress
      if (targetColumn === 'in-progress' && onDropInProgress) {
        onDropInProgress(draggedTask);
      }
    },
    [onMoveTask, onDropInProgress, tasks, columns]
  );

  const handleDragCancel = useCallback(() => {
    document.body.style.cursor = '';
    setActiveTask(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={kanbanCollision}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/*
          Touch-first horizontal rail: columns stay side-by-side on every
          viewport. On phones/tablets (<lg) the rail is swipeable with CSS
          scroll snap and responsive column widths so the next column peeks
          into view. Desktop (lg+) keeps the classic multi-column board.
        */}
        <div
          ref={railRef}
          data-board-rail
          onScroll={updateActiveColumn}
          className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain scroll-px-3 p-3 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] lg:snap-none lg:gap-4 lg:scroll-px-6 lg:p-6"
        >
        {columns.map((column, index) => (
          <motion.div
            key={column.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1, duration: 0.3 }}
            className="h-full w-[88vw] max-w-[26rem] shrink-0 snap-start sm:w-72 lg:w-80 lg:max-w-none"
          >
            <Column
              column={column}
              tasks={getTasksForColumn(column.id)}
              onTaskClick={onTaskClick}
              onEditTask={onEditTask}
              onDeleteTask={onDeleteTask}
              onArchiveTask={onArchiveTask}
              onUnarchiveTask={onUnarchiveTask}
              onRetryTask={onRetryTask}
              onAddTask={column.id === 'backlog' ? onAddTask : undefined}
              extraContent={
                getGroupsForColumn(column.id).map((g) => (
                  <TaskGroupCard
                    key={g.id}
                    group={g}
                    onClickGroup={onClickGroup ?? (() => {})}
                    onRunGroup={onRunGroup ?? (() => {})}
                    onStopGroup={onStopGroup ?? (() => {})}
                    onDeleteGroup={onDeleteGroup ?? (() => {})}
                    onEditGroup={onEditGroup}
                  />
                ))
              }
            />
          </motion.div>
        ))}
        </div>

        {/* Mobile position affordance — dots + "n of N", hidden on desktop */}
        <nav
          aria-label="Board columns"
          data-board-rail-nav
          className="flex shrink-0 items-center justify-center gap-0.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-0.5 lg:hidden"
        >
          {columns.map((column, index) => (
            <button
              key={column.id}
              type="button"
              onClick={() => scrollToColumn(index)}
              aria-label={`Go to ${column.title} column, ${index + 1} of ${columns.length}`}
              aria-current={activeColumn === index ? 'true' : undefined}
              className="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  'h-1.5 rounded-full transition-all duration-200',
                  activeColumn === index ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/40'
                )}
              />
            </button>
          ))}
          <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
            {activeColumn + 1} of {columns.length}
          </span>
          <span className="sr-only" aria-live="polite">
            {columns[activeColumn]?.title} column, {activeColumn + 1} of {columns.length}
          </span>
        </nav>
      </div>

      {/* Drag overlay */}
      <DragOverlay>
        {activeTask && (
          <div className="w-full max-w-80 rotate-3 opacity-90">
            <TaskCard task={activeTask} onClick={() => {}} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
