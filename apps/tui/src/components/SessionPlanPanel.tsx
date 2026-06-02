import type {
  IdempotencyKey,
  ProjectMember,
  ProjectMemberId,
  SessionId,
  SessionPlanTodo,
  SessionPlanTodoId
} from '@monad/protocol';

import {
  createIdempotencyKey,
  useAddSessionPlanTodoMutation,
  useDeleteSessionPlanTodoMutation,
  useListSessionPlanQuery,
  useListSessionProjectRosterQuery,
  useUpdateSessionPlanTodoMutation
} from '@monad/client-rtk';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useRef, useState } from 'react';

import { t } from '../lib/i18n.ts';
import {
  assignableRosterMembers,
  assignLanded,
  clampCursor,
  createIntentKeyMap,
  deleteLanded,
  findTodo,
  type IntentKeyMap,
  nextToggleStatus,
  resolveAssigneeName,
  type SessionPlanRowMode,
  sessionPlanAddText,
  toggleLanded
} from '../shell/session-plan-model.ts';
import { confirmDestructive } from '../shell/workspace-model.ts';
import { TUI_THEME } from './theme.ts';

function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'status' in error && (error as { status?: number }).status === 409
  );
}

function statusLabel(status: SessionPlanTodo['status']): string {
  if (status === 'in_progress') return t('cli.tui.plan.statusInProgress');
  if (status === 'completed') return t('cli.tui.plan.statusCompleted');
  return t('cli.tui.plan.statusPending');
}

function useIntentKeyMapRef<TIntent>(): IntentKeyMap<TIntent> {
  const ref = useRef<Map<string, { intent: TIntent; requestId: IdempotencyKey }>>(new Map());
  return useMemo(() => createIntentKeyMap<TIntent>(ref.current), []);
}

export function SessionPlanPanel({ active, sessionId }: { active: boolean; sessionId: SessionId }) {
  const { data, error: listError, isLoading, refetch } = useListSessionPlanQuery(sessionId);
  const { data: roster } = useListSessionProjectRosterQuery(sessionId);
  const [addTodoMut] = useAddSessionPlanTodoMutation();
  const [updateTodoMut] = useUpdateSessionPlanTodoMutation();
  const [deleteTodoMut] = useDeleteSessionPlanTodoMutation();

  const [mode, setMode] = useState<SessionPlanRowMode>('list');
  const [cursor, setCursor] = useState(0);
  const [assignCursor, setAssignCursor] = useState(0);
  const [draft, setDraft] = useState('');
  const [armedDelete, setArmedDelete] = useState<SessionPlanTodoId | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<SessionPlanTodoId>>(() => new Set());
  const [status, setStatus] = useState('');

  const toggleIntent = useIntentKeyMapRef<{ status: SessionPlanTodo['status'] }>();
  const assignIntent = useIntentKeyMapRef<{ assignee: ProjectMemberId | null }>();
  const deleteIntent = useIntentKeyMapRef<null>();

  const todos = data?.plan.todos ?? [];
  const cursorIndex = clampCursor(cursor, todos.length);
  const current = todos[cursorIndex];

  const rosterMembers: ProjectMember[] =
    roster?.entities && roster.ids
      ? roster.ids.map((id) => roster.entities[id]).filter((entry): entry is ProjectMember => entry != null)
      : [];
  const assignable = assignableRosterMembers(rosterMembers);

  function markPending(id: SessionPlanTodoId): void {
    setPendingIds((prev) => new Set(prev).add(id));
  }
  function clearPending(id: SessionPlanTodoId): void {
    setPendingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function submitAdd(text: string): Promise<void> {
    setMode('list');
    const value = sessionPlanAddText(text);
    setDraft('');
    if (!value) return;
    const requestId = createIdempotencyKey();
    try {
      await addTodoMut({ sessionId, requestId, text: value }).unwrap();
      setStatus('');
    } catch {
      setStatus(t('cli.tui.plan.addError'));
    }
  }

  async function toggleCurrent(): Promise<void> {
    if (!current || pendingIds.has(current.id)) return;
    setStatus('');
    markPending(current.id);
    const nextStatus = nextToggleStatus(current.status);
    const requestId = toggleIntent.keyFor(
      current.id,
      { status: nextStatus },
      (a, b) => a.status === b.status,
      createIdempotencyKey
    );
    try {
      await updateTodoMut({
        sessionId,
        todoId: current.id,
        requestId,
        expectedVersion: current.version,
        patch: { status: nextStatus }
      }).unwrap();
      toggleIntent.settle(current.id);
    } catch (cause) {
      if (isConflict(cause)) {
        setStatus(t('cli.tui.plan.conflictError'));
        toggleIntent.settle(current.id);
        void refetch();
      } else {
        const result = await refetch();
        const canonical = findTodo(result.data?.plan.todos ?? [], current.id);
        if (toggleLanded(canonical, nextStatus)) {
          toggleIntent.settle(current.id);
          setStatus('');
        } else {
          setStatus(t('cli.tui.plan.updateError'));
        }
      }
    } finally {
      clearPending(current.id);
    }
  }

  async function assignCurrent(assigneeProjectMemberId: ProjectMemberId | null, label: string): Promise<void> {
    if (!current) return;
    setMode('list');
    if (pendingIds.has(current.id)) return;
    setStatus('');
    markPending(current.id);
    const requestId = assignIntent.keyFor(
      current.id,
      { assignee: assigneeProjectMemberId },
      (a, b) => a.assignee === b.assignee,
      createIdempotencyKey
    );
    try {
      await updateTodoMut({
        sessionId,
        todoId: current.id,
        requestId,
        expectedVersion: current.version,
        patch: { assigneeProjectMemberId }
      }).unwrap();
      assignIntent.settle(current.id);
      setStatus(t('cli.tui.plan.assigned', { name: label }));
    } catch (cause) {
      if (isConflict(cause)) {
        setStatus(t('cli.tui.plan.conflictError'));
        assignIntent.settle(current.id);
        void refetch();
      } else {
        const result = await refetch();
        const canonical = findTodo(result.data?.plan.todos ?? [], current.id);
        if (assignLanded(canonical, assigneeProjectMemberId)) {
          assignIntent.settle(current.id);
          setStatus(t('cli.tui.plan.assigned', { name: label }));
        } else {
          setStatus(t('cli.tui.plan.updateError'));
        }
      }
    } finally {
      clearPending(current.id);
    }
  }

  async function deleteCurrent(): Promise<void> {
    if (!current || pendingIds.has(current.id)) return;
    const confirmation = confirmDestructive(armedDelete, current.id);
    setArmedDelete(confirmation.armedId as SessionPlanTodoId | null);
    if (!confirmation.confirmed) {
      setStatus(t('cli.tui.plan.deleteConfirm', { text: current.text }));
      return;
    }
    setStatus('');
    markPending(current.id);
    const requestId = deleteIntent.keyFor(current.id, null, () => true, createIdempotencyKey);
    try {
      await deleteTodoMut({ sessionId, todoId: current.id, requestId, expectedVersion: current.version }).unwrap();
      deleteIntent.settle(current.id);
      setStatus(t('cli.tui.plan.deleted'));
    } catch (cause) {
      if (isConflict(cause)) {
        setStatus(t('cli.tui.plan.conflictError'));
        deleteIntent.settle(current.id);
        void refetch();
      } else {
        const result = await refetch();
        const canonical = findTodo(result.data?.plan.todos ?? [], current.id);
        if (deleteLanded(canonical)) {
          deleteIntent.settle(current.id);
          setStatus(t('cli.tui.plan.deleted'));
        } else {
          setStatus(t('cli.tui.plan.deleteError'));
        }
      }
    } finally {
      clearPending(current.id);
    }
  }

  useInput(
    (input, key) => {
      if (mode === 'add') {
        if (key.escape) {
          setMode('list');
          setDraft('');
        }
        return;
      }
      if (mode === 'assign') {
        const optionCount = assignable.length + 1;
        if (key.escape) {
          setMode('list');
        } else if (key.upArrow || input === 'k') {
          setAssignCursor((value) => clampCursor(value - 1, optionCount));
        } else if (key.downArrow || input === 'j') {
          setAssignCursor((value) => clampCursor(value + 1, optionCount));
        } else if (key.return) {
          if (assignCursor === 0) void assignCurrent(null, t('cli.tui.plan.unassigned'));
          else {
            const member = assignable[assignCursor - 1];
            if (member) void assignCurrent(member.id, member.displayName);
          }
        }
        return;
      }
      if (current && armedDelete !== current.id) setArmedDelete(null);
      if (key.upArrow || input === 'k') {
        setCursor((value) => clampCursor(value - 1, todos.length));
      } else if (key.downArrow || input === 'j') {
        setCursor((value) => clampCursor(value + 1, todos.length));
      } else if (input === 'r') {
        void refetch();
      } else if (input === 'a') {
        setMode('add');
        setDraft('');
      } else if ((key.return || input === ' ') && current) {
        void toggleCurrent();
      } else if (input === 'm' && current) {
        setAssignCursor(0);
        setMode('assign');
      } else if (input === 'x' && current) {
        void deleteCurrent();
      }
    },
    { isActive: active }
  );

  return (
    <Box
      borderColor={active ? TUI_THEME.accent : TUI_THEME.frame}
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {t('cli.tui.plan.title')}
      </Text>

      {isLoading ? <Text color={TUI_THEME.dim}>{t('cli.tui.plan.loading')}</Text> : null}
      {listError ? <Text color={TUI_THEME.danger}>{t('cli.tui.plan.errorLoad')}</Text> : null}
      {!isLoading && !listError && todos.length === 0 ? (
        <Text color={TUI_THEME.dim}>{t('cli.tui.plan.empty')}</Text>
      ) : null}

      {!isLoading && !listError
        ? todos.map((todo, index) => (
            <SessionPlanRow
              armed={armedDelete === todo.id}
              key={todo.id}
              pending={pendingIds.has(todo.id)}
              roster={rosterMembers}
              selected={index === cursorIndex && mode === 'list'}
              todo={todo}
            />
          ))
        : null}

      {mode === 'add' ? (
        <Box marginTop={1}>
          <Text color={TUI_THEME.accent}>{t('cli.tui.plan.addPrompt')} </Text>
          <TextInput
            onChange={setDraft}
            onSubmit={submitAdd}
            placeholder={t('cli.tui.plan.addPlaceholder')}
            value={draft}
          />
        </Box>
      ) : null}

      {mode === 'assign' ? (
        <Box
          flexDirection="column"
          marginTop={1}
        >
          <Text color={TUI_THEME.accent}>{t('cli.tui.plan.assignPrompt')}</Text>
          <AssignOptionRow
            label={t('cli.tui.plan.unassign')}
            selected={assignCursor === 0}
          />
          {assignable.length === 0 ? <Text color={TUI_THEME.dim}>{t('cli.tui.plan.assignEmpty')}</Text> : null}
          {assignable.map((member, index) => (
            <AssignOptionRow
              key={member.id}
              label={member.displayName}
              selected={assignCursor === index + 1}
            />
          ))}
        </Box>
      ) : null}

      {status ? (
        <Box marginTop={1}>
          <Text color={armedDelete ? TUI_THEME.warning : TUI_THEME.dim}>{status}</Text>
        </Box>
      ) : null}

      <Text color={TUI_THEME.dim}>{t('cli.tui.plan.readOnlyHint')}</Text>
    </Box>
  );
}

function AssignOptionRow({ label, selected }: { label: string; selected: boolean }) {
  return (
    <Box>
      <Text color={selected ? TUI_THEME.accent : TUI_THEME.dim}>{selected ? '› ' : '  '}</Text>
      <Text color={selected ? TUI_THEME.accent : undefined}>{label}</Text>
    </Box>
  );
}

function SessionPlanRow({
  todo,
  roster,
  selected,
  armed,
  pending
}: {
  todo: SessionPlanTodo;
  roster: readonly ProjectMember[];
  selected: boolean;
  armed: boolean;
  pending: boolean;
}) {
  const completed = todo.status === 'completed';
  const box = completed ? '[x]' : '[ ]';
  const assigneeText = todo.assigneeProjectMemberId
    ? (resolveAssigneeName(roster, todo.assigneeProjectMemberId) ??
      t('cli.tui.plan.assigneeUnresolved', { id: todo.assigneeProjectMemberId }))
    : t('cli.tui.plan.unassigned');

  return (
    <Box>
      <Text color={selected ? TUI_THEME.accent : TUI_THEME.dim}>{selected ? '› ' : '  '}</Text>
      <Text color={completed ? TUI_THEME.glow : undefined}>{box} </Text>
      <Text
        color={completed ? TUI_THEME.dim : undefined}
        strikethrough={completed}
      >
        {todo.text}
      </Text>
      <Text color={TUI_THEME.dim}>
        {'  '}
        {todo.status === 'in_progress' ? `${statusLabel(todo.status)} · ` : ''}
        {assigneeText}
      </Text>
      {armed ? <Text color={TUI_THEME.warning}> · x to confirm</Text> : null}
      {pending ? <Text color={TUI_THEME.dim}> · …</Text> : null}
    </Box>
  );
}
