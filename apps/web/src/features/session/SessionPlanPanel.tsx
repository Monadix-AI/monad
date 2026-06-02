import type { MonadApiError } from '@monad/client-rtk';
import type { IdempotencyKey, ProjectMemberId, SessionId, SessionPlanTodo, SessionPlanTodoId } from '@monad/protocol';

import {
  createIdempotencyKey,
  useAddSessionPlanTodoMutation,
  useDeleteSessionPlanTodoMutation,
  useListSessionPlanQuery,
  useListSessionProjectRosterQuery,
  useUpdateSessionPlanTodoMutation
} from '@monad/client-rtk';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner
} from '@monad/ui';
import { type SyntheticEvent, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { SessionPlanTodoRow } from './SessionPlanTodoRow';

const UNASSIGNED = '__unassigned__';
// The add form has no todoId yet, so its intent slot uses a fixed key distinct from any real todoId.
const ADD_INTENT_ID = 'add';

function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as MonadApiError).status === 409;
}

// Keys a pending mutation's idempotency key to (target id, intent), so a retry against the SAME
// target with the SAME intent (the request failed/timed out but may have actually committed)
// replays the identical requestId, while any OTHER target — even one with an identical intent
// shape, e.g. the same status flip on a different todo — always gets its own key. A single shared
// slot without the target id would let todo B's mutation reuse todo A's still-pending key after
// A's request failed, silently misattributing B's action to A's retry.
function useIntentKeyMap<TIntent>() {
  const ref = useRef(new Map<string, { intent: TIntent; requestId: IdempotencyKey }>());
  return {
    keyFor(id: string, intent: TIntent, sameIntent: (a: TIntent, b: TIntent) => boolean): IdempotencyKey {
      const current = ref.current.get(id);
      if (current && sameIntent(current.intent, intent)) return current.requestId;
      const requestId = createIdempotencyKey();
      ref.current.set(id, { intent, requestId });
      return requestId;
    },
    settle(id: string): void {
      ref.current.delete(id);
    }
  };
}

export function SessionPlanPanel({ sessionId }: { sessionId: SessionId }) {
  const t = useT();
  const { data, error: listError, isLoading, refetch } = useListSessionPlanQuery(sessionId);
  // Every ProjectMember of the session's project (not just this session's live bindings) — the
  // daemon accepts any enabled project member as an assignee, and a former/disabled member's name
  // must still resolve for a todo that's already assigned to them.
  const { data: roster } = useListSessionProjectRosterQuery(sessionId);
  const [addTodo, { isLoading: adding }] = useAddSessionPlanTodoMutation();
  const [updateTodo] = useUpdateSessionPlanTodoMutation();
  const [deleteTodo] = useDeleteSessionPlanTodoMutation();
  const [text, setText] = useState('');
  const [addAssignee, setAddAssignee] = useState<ProjectMemberId | null>(null);
  const [pendingTodoIds, setPendingTodoIds] = useState<ReadonlySet<SessionPlanTodoId>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const addIntent = useIntentKeyMap<{ text: string; assignee: ProjectMemberId | null }>();
  const toggleIntent = useIntentKeyMap<{ status: SessionPlanTodo['status'] }>();
  const assignIntent = useIntentKeyMap<{ assignee: ProjectMemberId | null }>();
  const deleteIntent = useIntentKeyMap<null>();

  function markPending(todoId: SessionPlanTodoId): void {
    setPendingTodoIds((prev) => {
      const next = new Set(prev);
      next.add(todoId);
      return next;
    });
  }
  function clearPending(todoId: SessionPlanTodoId): void {
    setPendingTodoIds((prev) => {
      if (!prev.has(todoId)) return prev;
      const next = new Set(prev);
      next.delete(todoId);
      return next;
    });
  }

  const rosterMembers =
    roster?.entities && roster.ids
      ? roster.ids.map((id) => roster.entities[id]).filter((entry): entry is NonNullable<typeof entry> => entry != null)
      : [];
  // Only enabled members are legal assignment targets — the daemon rejects any other.
  const assignableOptions = rosterMembers
    .filter((member) => member.lifecycle === 'enabled')
    .map((member) => ({ id: member.id, displayName: member.displayName }));
  // Resolution stays independent of assignability: a todo already assigned to a disabled/former
  // member must still show their real name, never fall back to "Unassigned".
  const resolveAssigneeName = (memberId: ProjectMemberId): string | null =>
    rosterMembers.find((member) => member.id === memberId)?.displayName ?? null;

  async function handleAdd(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setActionError(null);
    const requestId = addIntent.keyFor(
      ADD_INTENT_ID,
      { text: value, assignee: addAssignee },
      (a, b) => a.text === b.text && a.assignee === b.assignee
    );
    try {
      await addTodo({
        sessionId,
        requestId,
        text: value,
        ...(addAssignee ? { assigneeProjectMemberId: addAssignee } : {})
      }).unwrap();
      addIntent.settle(ADD_INTENT_ID);
      setText('');
      setAddAssignee(null);
    } catch (error) {
      setActionError(t('web.plan.addError'));
      if (isConflict(error)) addIntent.settle(ADD_INTENT_ID);
    }
  }

  // A non-409 error only tells us the CALLER didn't see a success response — the mutation may have
  // actually committed (the endpoint invalidates SessionPlan on every settle, success or failure).
  // Rather than leaving a permanent "try again" banner, refetch and check the canonical outcome: if
  // it landed, this was a lost response, not a real failure — settle the key and clear the error;
  // if it didn't land, keep the error (and the key, so a retry replays the same requestId).
  async function resolveUncertainOutcome(
    todoId: SessionPlanTodoId,
    landed: (canonicalTodo: SessionPlanTodo | undefined) => boolean,
    settle: () => void,
    errorMessage: string
  ): Promise<void> {
    const result = await refetch();
    const canonicalTodo = result.data?.plan.todos.find((candidate) => candidate.id === todoId);
    if (landed(canonicalTodo)) {
      settle();
      setActionError(null);
    } else {
      setActionError(errorMessage);
    }
  }

  async function handleToggle(todo: SessionPlanTodo) {
    setActionError(null);
    markPending(todo.id);
    const nextStatus = todo.status === 'completed' ? 'pending' : 'completed';
    const requestId = toggleIntent.keyFor(todo.id, { status: nextStatus }, (a, b) => a.status === b.status);
    try {
      await updateTodo({
        sessionId,
        todoId: todo.id,
        requestId,
        expectedVersion: todo.version,
        patch: { status: nextStatus }
      }).unwrap();
      toggleIntent.settle(todo.id);
    } catch (error) {
      if (isConflict(error)) {
        setActionError(t('web.plan.conflictError'));
        toggleIntent.settle(todo.id);
        void refetch();
      } else {
        await resolveUncertainOutcome(
          todo.id,
          (canonicalTodo) => canonicalTodo?.status === nextStatus,
          () => toggleIntent.settle(todo.id),
          t('web.plan.updateError')
        );
      }
    } finally {
      clearPending(todo.id);
    }
  }

  async function handleAssign(todo: SessionPlanTodo, assigneeProjectMemberId: ProjectMemberId | null) {
    setActionError(null);
    markPending(todo.id);
    const requestId = assignIntent.keyFor(
      todo.id,
      { assignee: assigneeProjectMemberId },
      (a, b) => a.assignee === b.assignee
    );
    try {
      await updateTodo({
        sessionId,
        todoId: todo.id,
        requestId,
        expectedVersion: todo.version,
        patch: { assigneeProjectMemberId }
      }).unwrap();
      assignIntent.settle(todo.id);
    } catch (error) {
      if (isConflict(error)) {
        setActionError(t('web.plan.conflictError'));
        assignIntent.settle(todo.id);
        void refetch();
      } else {
        await resolveUncertainOutcome(
          todo.id,
          (canonicalTodo) => (canonicalTodo?.assigneeProjectMemberId ?? null) === assigneeProjectMemberId,
          () => assignIntent.settle(todo.id),
          t('web.plan.updateError')
        );
      }
    } finally {
      clearPending(todo.id);
    }
  }

  async function handleDelete(todo: SessionPlanTodo) {
    setActionError(null);
    markPending(todo.id);
    const requestId = deleteIntent.keyFor(todo.id, null, () => true);
    try {
      await deleteTodo({ sessionId, todoId: todo.id, requestId, expectedVersion: todo.version }).unwrap();
      deleteIntent.settle(todo.id);
    } catch (error) {
      if (isConflict(error)) {
        setActionError(t('web.plan.conflictError'));
        deleteIntent.settle(todo.id);
        void refetch();
      } else {
        await resolveUncertainOutcome(
          todo.id,
          (canonicalTodo) => canonicalTodo === undefined,
          () => deleteIntent.settle(todo.id),
          t('web.plan.deleteError')
        );
      }
    } finally {
      clearPending(todo.id);
    }
  }

  const todos = data?.plan.todos ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex flex-col gap-2 border-border/70 border-b px-4 py-3"
        onSubmit={handleAdd}
      >
        <div className="flex items-center gap-2">
          <Input
            aria-label={t('web.plan.addPlaceholder')}
            className="h-8 flex-1"
            onChange={(event) => setText(event.target.value)}
            placeholder={t('web.plan.addPlaceholder')}
            value={text}
          />
          <Button
            className="h-8 shrink-0 gap-1.5"
            disabled={adding || text.trim().length === 0}
            size="sm"
            type="submit"
          >
            {adding ? <Spinner className="size-3.5" /> : null}
            {t('web.plan.addButton')}
          </Button>
        </div>
        {assignableOptions.length > 0 ? (
          <Select
            onValueChange={(value) => setAddAssignee(value === UNASSIGNED ? null : (value as ProjectMemberId))}
            value={addAssignee ?? UNASSIGNED}
          >
            <SelectTrigger
              aria-label={t('web.plan.assignee')}
              className="h-7 w-full text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>{t('web.plan.unassigned')}</SelectItem>
              {assignableOptions.map((option) => (
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
      </form>

      {actionError ? (
        <p
          aria-live="assertive"
          className="px-4 pt-2 text-destructive text-xs"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}

      {isLoading ? (
        <div
          aria-label={t('web.plan.loading')}
          className="flex flex-col gap-2 px-4 py-3"
          role="status"
        >
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : listError ? (
        <div className="flex flex-col items-start gap-2 px-4 py-4 text-sm">
          <p>{t('web.plan.errorLoad')}</p>
          <Button
            onClick={() => refetch()}
            size="sm"
            variant="secondary"
          >
            {t('web.plan.retry')}
          </Button>
        </div>
      ) : todos.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-8 py-10 text-center text-muted-foreground text-sm">
          <p className="font-medium text-foreground">{t('web.plan.empty')}</p>
          <p className="text-xs">{t('web.plan.emptyHint')}</p>
        </div>
      ) : (
        <ul className="flex flex-col px-2 py-2">
          {todos.map((todo) => (
            <SessionPlanTodoRow
              assigneeOptions={assignableOptions}
              assigning={pendingTodoIds.has(todo.id)}
              deleting={pendingTodoIds.has(todo.id)}
              key={todo.id}
              onAssign={handleAssign}
              onDelete={handleDelete}
              onToggle={handleToggle}
              resolveAssigneeName={resolveAssigneeName}
              todo={todo}
              toggling={pendingTodoIds.has(todo.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
