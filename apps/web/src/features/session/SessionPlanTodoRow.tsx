import type { ProjectMemberId, SessionPlanTodo } from '@monad/protocol';

import { CheckmarkSquare02Icon, Delete02Icon, SquareIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';

import { DestructiveConfirmPopover } from '#/components/DestructiveConfirmPopover';
import { HoverActions } from '#/components/HoverActions';
import { useT } from '#/components/I18nProvider';

// Radix Select rejects an empty-string item value, so "no assignee" needs a real sentinel.
const UNASSIGNED = '__unassigned__';

function statusLabel(status: SessionPlanTodo['status'], t: ReturnType<typeof useT>): string {
  switch (status) {
    case 'in_progress':
      return t('web.plan.statusInProgress');
    case 'completed':
      return t('web.plan.statusCompleted');
    default:
      return t('web.plan.statusPending');
  }
}

export function SessionPlanTodoRow({
  todo,
  assigneeOptions,
  resolveAssigneeName,
  onToggle,
  onAssign,
  onDelete,
  toggling,
  assigning,
  deleting
}: {
  todo: SessionPlanTodo;
  assigneeOptions: Array<{ id: ProjectMemberId; displayName: string }>;
  // Resolves ANY project member's name, including ones no longer selectable in `assigneeOptions`
  // (left the session, or disabled) — so an already-assigned todo never falsely renders as
  // "Unassigned" just because its assignee dropped out of the current pick list. Returns null only
  // when the member genuinely can't be resolved at all (e.g. the roster fetch itself failed).
  resolveAssigneeName: (memberId: ProjectMemberId) => string | null;
  onToggle: (todo: SessionPlanTodo) => void;
  onAssign: (todo: SessionPlanTodo, assigneeProjectMemberId: ProjectMemberId | null) => void;
  onDelete: (todo: SessionPlanTodo) => void;
  toggling: boolean;
  assigning: boolean;
  deleting: boolean;
}) {
  const t = useT();
  const completed = todo.status === 'completed';
  const toggleLabel = completed ? t('web.plan.markPending') : t('web.plan.markCompleted');
  const assigneeName = todo.assigneeProjectMemberId
    ? (resolveAssigneeName(todo.assigneeProjectMemberId) ??
      t('web.plan.assigneeUnresolved', { id: todo.assigneeProjectMemberId }))
    : t('web.plan.unassigned');

  return (
    <li className="group flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
      <button
        aria-label={toggleLabel}
        aria-pressed={completed}
        className="-m-1.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:size-11"
        disabled={toggling}
        onClick={() => onToggle(todo)}
        title={toggleLabel}
        type="button"
      >
        <HugeiconsIcon
          className={cn('size-4', completed && 'text-success')}
          icon={completed ? CheckmarkSquare02Icon : SquareIcon}
        />
      </button>
      <div className="min-w-0 flex-1 py-0.5">
        <p className={cn('break-words text-sm', completed && 'text-muted-foreground line-through')}>{todo.text}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {todo.status === 'in_progress' ? (
            <span className="text-info text-xs">{statusLabel(todo.status, t)}</span>
          ) : null}
          {assigneeOptions.length > 0 || todo.assigneeProjectMemberId ? (
            <Select
              disabled={assigning}
              onValueChange={(value) => onAssign(todo, value === UNASSIGNED ? null : (value as ProjectMemberId))}
              value={todo.assigneeProjectMemberId ?? UNASSIGNED}
            >
              <SelectTrigger
                aria-label={t('web.plan.assignee')}
                className="h-6 w-auto max-w-40 border-none bg-transparent px-1.5 text-muted-foreground text-xs shadow-none hover:bg-muted/60"
              >
                <SelectValue>{assigneeName}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>{t('web.plan.unassigned')}</SelectItem>
                {assigneeOptions.map((option) => (
                  <SelectItem
                    key={option.id}
                    value={option.id}
                  >
                    {option.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>
      <HoverActions>
        <DestructiveConfirmPopover
          confirmLabel={t('web.plan.deleteConfirmAction')}
          description={t('web.plan.deleteConfirmDescription', { text: todo.text })}
          onConfirm={() => Promise.resolve(onDelete(todo))}
        >
          <Button
            aria-label={t('web.plan.deleteTodo')}
            className="size-7 shrink-0"
            disabled={deleting}
            size="icon"
            title={t('web.plan.deleteTodo')}
            variant="ghost"
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={Delete02Icon}
            />
          </Button>
        </DestructiveConfirmPopover>
      </HoverActions>
    </li>
  );
}
