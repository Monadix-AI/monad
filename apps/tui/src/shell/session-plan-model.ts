import type {
  IdempotencyKey,
  ProjectMember,
  SessionPlanTodo,
  SessionPlanTodoId,
  SessionPlanTodoStatus
} from '@monad/protocol';

export type SessionPlanRowMode = 'list' | 'add' | 'assign';

// Same trim/empty-guard as the web panel's add form — an empty (or whitespace-only) submission is a
// no-op, not an error.
export function sessionPlanAddText(raw: string): string | null {
  const value = raw.trim();
  return value ? value : null;
}

export function nextToggleStatus(status: SessionPlanTodoStatus): SessionPlanTodoStatus {
  return status === 'completed' ? 'pending' : 'completed';
}

export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, cursor), length - 1);
}

// Only `lifecycle === 'enabled'` project members are legal assignment targets — the daemon rejects
// any other (session-plan-mutations.ts). Mirrors the web panel's `assignableOptions` derivation.
export function assignableRosterMembers(roster: readonly ProjectMember[]): ProjectMember[] {
  return roster.filter((member) => member.lifecycle === 'enabled');
}

// Resolves ANY roster member's name, including ones no longer in `assignableRosterMembers` (left the
// project, or disabled) — a todo already assigned to them must still show their real name, never
// silently collapse to "Unassigned". Returns null only when genuinely unresolvable (e.g. the roster
// fetch itself failed or the member id isn't present at all).
export function resolveAssigneeName(roster: readonly ProjectMember[], memberId: string): string | null {
  return roster.find((member) => member.id === memberId)?.displayName ?? null;
}

export interface IntentKeyMap<TIntent> {
  keyFor(
    id: string,
    intent: TIntent,
    sameIntent: (a: TIntent, b: TIntent) => boolean,
    mint: () => IdempotencyKey
  ): IdempotencyKey;
  settle(id: string): void;
}

// Keys a pending mutation's idempotency key to (target id, intent) — a retry against the SAME target
// with the SAME intent (the request failed/timed out but may have actually committed) replays the
// identical requestId, while any OTHER target — even an identical intent shape, e.g. the same status
// flip on a different todo — always gets its own key. Framework-agnostic (the caller supplies the
// backing Map and the key-minting function) so this stays unit-testable without a React runtime; the
// TUI and web layers each wrap it in their own thin stateful adapter.
export function createIntentKeyMap<TIntent>(
  store: Map<string, { intent: TIntent; requestId: IdempotencyKey }>
): IntentKeyMap<TIntent> {
  return {
    keyFor(id, intent, sameIntent, mint) {
      const current = store.get(id);
      if (current && sameIntent(current.intent, intent)) return current.requestId;
      const requestId = mint();
      store.set(id, { intent, requestId });
      return requestId;
    },
    settle(id) {
      store.delete(id);
    }
  };
}

// Whether a non-409 mutation error actually landed (server committed, response merely lost) — the
// caller refetches and passes the canonical post-refetch todo (or its absence, for delete) here to
// decide whether to settle the retry key and clear the error, or keep both for a genuine retry.
export function toggleLanded(
  canonicalTodo: SessionPlanTodo | undefined,
  intendedStatus: SessionPlanTodoStatus
): boolean {
  return canonicalTodo?.status === intendedStatus;
}

export function assignLanded(canonicalTodo: SessionPlanTodo | undefined, intendedAssignee: string | null): boolean {
  return canonicalTodo !== undefined && (canonicalTodo.assigneeProjectMemberId ?? null) === intendedAssignee;
}

export function deleteLanded(canonicalTodo: SessionPlanTodo | undefined): boolean {
  return canonicalTodo === undefined;
}

export function findTodo(todos: readonly SessionPlanTodo[], id: SessionPlanTodoId): SessionPlanTodo | undefined {
  return todos.find((todo) => todo.id === id);
}
