// Real component behavior tests for SessionPlanPanel/SessionPlanTodoRow — fires actual user
// interactions (click/type) against a real DOM (happy-dom) and a real Redux store wired to a
// stateful fake daemon client, asserting the resulting DOM state and the exact requests sent.
// This is deliberately NOT a re-run of client-rtk's endpoint-level cache tests: it proves the web
// component wires those endpoints correctly (accessible names, confirm-before-delete, idempotent
// retry — including a "server committed but the response was lost" replay, not just a
// before-commit failure — 409 recovery, assignee selection, and requestId isolation across rows).

// Must be the first import in the file — it registers happy-dom before anything below imports
// @testing-library/react, which snapshots `document` availability at its own module-eval time.
import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import type { MonadClient } from '@monad/client';
import type { ProjectId, SessionId } from '@monad/protocol';

import { beforeEach, describe, expect, test } from 'bun:test';
import { createMonadStore, updateWorkplaceProjectApi } from '@monad/client-rtk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { SessionPlanPanel } from '../../src/features/session/SessionPlanPanel';

const sessionId = 'ses_100000000000' as SessionId;
const projectId = 'prj_100000000000' as ProjectId;
const origin = { source: { surface: 'web' as const, client: 'monad-web', transport: 'http' as const } };
const now = '2026-07-29T00:00:00.000Z';

interface FakeTodo {
  id: string;
  sessionId: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  assigneeProjectMemberId?: string;
  version: number;
  createdBy: typeof origin;
  updatedBy: typeof origin;
  createdAt: string;
  updatedAt: string;
}

type MutationOp = 'add' | 'update' | 'delete';

function ok<T>(data: T): { data: T; status: number } {
  return { data, status: 200 };
}
function err(status: number, error: string, code: string): { error: { status: number; value: unknown } } {
  return { error: { status, value: { error, code } } };
}

function fakePlanServer() {
  let nextId = 1;
  const todos = new Map<string, FakeTodo>();
  const mutations = new Map<string, { fingerprint: string; result: unknown }>();
  const requestIdsSeen: string[] = [];
  const failResponseOnce: Record<MutationOp, boolean> = { add: false, update: false, delete: false };
  const failRequestOnce: Record<MutationOp, boolean> = { add: false, update: false, delete: false };

  function bump(requestId: string): void {
    requestIdsSeen.push(requestId);
  }

  return {
    todos,
    requestIdsSeen,
    // Simulates "the server committed the mutation, but the caller never saw the response" — the
    // NEXT successful commit for `op` still writes durable state + the idempotency ledger, but
    // returns an error instead of the real result. A correct client must replay the SAME
    // requestId and get back the ONE committed result, never double-apply the mutation.
    failNextResponse(op: MutationOp): void {
      failResponseOnce[op] = true;
    },
    // Simulates a genuine failure that never reaches the store — nothing commits, so the
    // canonical state after the failure is unchanged from before the call.
    failNextRequest(op: MutationOp): void {
      failRequestOnce[op] = true;
    },
    get: () => ok({ plan: { sessionId, todos: [...todos.values()] } }),
    addTodo: (body: { requestId: string; text: string; assigneeProjectMemberId?: string }) => {
      bump(body.requestId);
      const fingerprint = `add:${body.text}:${body.assigneeProjectMemberId ?? ''}`;
      const existing = mutations.get(body.requestId);
      let result: { todo: FakeTodo };
      if (existing) {
        if (existing.fingerprint !== fingerprint) return err(409, 'idempotency conflict', 'CONFLICT');
        result = existing.result as { todo: FakeTodo };
      } else {
        const todo: FakeTodo = {
          id: `todo_${String(nextId++).padStart(12, '0')}`,
          sessionId,
          text: body.text,
          status: 'pending',
          version: 0,
          createdBy: origin,
          updatedBy: origin,
          createdAt: now,
          updatedAt: now,
          ...(body.assigneeProjectMemberId ? { assigneeProjectMemberId: body.assigneeProjectMemberId } : {})
        };
        todos.set(todo.id, todo);
        result = { todo };
        mutations.set(body.requestId, { fingerprint, result });
      }
      if (failResponseOnce.add) {
        failResponseOnce.add = false;
        return err(500, 'simulated response loss', 'INTERNAL');
      }
      return ok(result);
    },
    updateTodo: (
      todoId: string,
      body: {
        requestId: string;
        expectedVersion: number;
        patch: { status?: string; assigneeProjectMemberId?: string | null };
      },
      forceConflict = false
    ) => {
      bump(body.requestId);
      if (forceConflict) return err(409, 'version conflict', 'CONFLICT');
      if (failRequestOnce.update) {
        failRequestOnce.update = false;
        return err(500, 'simulated pre-commit failure', 'INTERNAL');
      }
      const fingerprint = `update:${todoId}:${body.expectedVersion}:${JSON.stringify(body.patch)}`;
      const existing = mutations.get(body.requestId);
      let result: { todo: FakeTodo };
      if (existing) {
        if (existing.fingerprint !== fingerprint) return err(409, 'idempotency conflict', 'CONFLICT');
        result = existing.result as { todo: FakeTodo };
      } else {
        const current = todos.get(todoId);
        if (!current) return err(404, 'not found', 'NOT_FOUND');
        if (current.version !== body.expectedVersion) return err(409, 'version conflict', 'CONFLICT');
        const updated: FakeTodo = {
          ...current,
          ...(body.patch.status ? { status: body.patch.status as FakeTodo['status'] } : {}),
          ...('assigneeProjectMemberId' in body.patch
            ? { assigneeProjectMemberId: body.patch.assigneeProjectMemberId ?? undefined }
            : {}),
          version: current.version + 1,
          updatedBy: origin,
          updatedAt: now
        };
        todos.set(todoId, updated);
        result = { todo: updated };
        mutations.set(body.requestId, { fingerprint, result });
      }
      if (failResponseOnce.update) {
        failResponseOnce.update = false;
        return err(500, 'simulated response loss', 'INTERNAL');
      }
      return ok(result);
    },
    deleteTodo: (todoId: string, body: { requestId: string; expectedVersion: number }) => {
      bump(body.requestId);
      const fingerprint = `delete:${todoId}:${body.expectedVersion}`;
      const existing = mutations.get(body.requestId);
      let result: { deleted: true; todoId: string };
      if (existing) {
        result = existing.result as { deleted: true; todoId: string };
      } else {
        const current = todos.get(todoId);
        if (!current) return err(404, 'not found', 'NOT_FOUND');
        if (current.version !== body.expectedVersion) return err(409, 'version conflict', 'CONFLICT');
        todos.delete(todoId);
        result = { deleted: true, todoId };
        mutations.set(body.requestId, { fingerprint, result });
      }
      if (failResponseOnce.delete) {
        failResponseOnce.delete = false;
        return err(500, 'simulated response loss', 'INTERNAL');
      }
      return ok(result);
    }
  };
}

function clientOverPlanServer(
  server: ReturnType<typeof fakePlanServer>,
  members: Array<{ id: string; displayName: string; lifecycle?: 'enabled' | 'disabled' }>
): MonadClient {
  let rosterSnapshot = members;
  let patchGate: { promise: Promise<void>; resolve: () => void } | null = null;
  const client = {
    treaty: {
      v1: {
        sessions: ({ id: _id }: { id: string }) => ({
          plan: Object.assign(
            { get: async () => server.get() },
            {
              todos: Object.assign(
                ({ todoId }: { todoId: string }) => ({
                  patch: async (body: never) => {
                    if (patchGate) await patchGate.promise;
                    return server.updateTodo(todoId, body);
                  },
                  delete: async (body: never) => server.deleteTodo(todoId, body)
                }),
                { post: async (body: never) => server.addTodo(body) }
              )
            }
          ),
          'project-roster': {
            get: async () =>
              ok({
                members: rosterSnapshot.map((m) => ({
                  id: m.id,
                  projectId,
                  profileId: 'codex',
                  type: 'mesh-agent' as const,
                  displayName: m.displayName,
                  customPrompt: null,
                  launchOverrides: {},
                  workingDirectoryOverride: null,
                  lifecycle: m.lifecycle ?? ('enabled' as const),
                  createdAt: now,
                  updatedAt: now
                }))
              })
          }
        }),
        workplace: {
          projects: ({ id }: { id: string }) => ({
            // The daemon commits a memberTemplates reconcile onto canonical ProjectMember rows
            // synchronously within this same request — by the time the response returns, the
            // roster GET below already reflects it. `__setRoster` stages exactly that: the
            // post-reconcile roster the test expects this PATCH to have caused.
            patch: async () =>
              ok({
                project: {
                  id,
                  title: 'Test project',
                  state: 'active' as const,
                  archived: false,
                  memberTemplates: [],
                  createdAt: now,
                  updatedAt: now
                }
              })
          })
        }
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  };
  return {
    ...(client as unknown as MonadClient),
    __setRoster: (next: Array<{ id: string; displayName: string; lifecycle?: 'enabled' | 'disabled' }>) => {
      rosterSnapshot = next;
    },
    // Holds the NEXT todo PATCH open until resumed — used to observe UI state while a mutation is
    // genuinely still in flight, rather than racing real network/microtask timing.
    __pausePatch: (): void => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      patchGate = { promise, resolve };
    },
    __resumePatch: (): void => {
      patchGate?.resolve();
      patchGate = null;
    }
  } as unknown as MonadClient & {
    __setRoster: (next: Array<{ id: string; displayName: string; lifecycle?: 'enabled' | 'disabled' }>) => void;
    __pausePatch: () => void;
    __resumePatch: () => void;
  };
}

let server: ReturnType<typeof fakePlanServer>;
let client: ReturnType<typeof clientOverPlanServer>;
let store: ReturnType<typeof createMonadStore>;

beforeEach(() => {
  server = fakePlanServer();
  client = clientOverPlanServer(server, [{ id: 'pmem_codex000001', displayName: 'Codex' }]);
  store = createMonadStore({ client });
});

// `dom-test-env.ts` already registers a global `afterEach(cleanup)` that unmounts every render
// tree via React's own teardown (flushing effects, canceling in-flight subscriptions). Manually
// wiping `document.body.innerHTML` here — a second, LATER-or-EARLIER-ordered afterEach relative to
// that one, order is not guaranteed — ripped the DOM out from under React without going through
// unmount, leaving fiber roots (and their pending RTK Query subscriptions/timers) alive and firing
// updates into whatever DOM the NEXT test had already rendered. That's what made the pending-lock
// test's captured `row`/trigger references go stale (`isConnected === false`) only when run as part
// of the full suite, never in isolation. Rely solely on the real `cleanup()`.

function renderPanel() {
  return render(
    <Provider store={store}>
      <SessionPlanPanel sessionId={sessionId} />
    </Provider>
  );
}

function lastRequestId(): string {
  const id = server.requestIdsSeen.at(-1);
  if (!id) throw new Error('expected at least one request to have been sent');
  return id;
}

async function addTodo(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText('Add a todo'), text);
  await user.click(screen.getByRole('button', { name: 'Add todo' }));
  await waitFor(() => expect(screen.getByText(text)).toBeVisible());
}

describe('SessionPlanPanel', () => {
  test('empty state renders the add action and no todos', async () => {
    renderPanel();
    expect(await screen.findByText('No todos yet')).toBeVisible();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  test('adding a todo sends the exact request and renders it in the list', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');

    await addTodo(user, 'Ship the panel');

    expect(server.todos.size).toBe(1);
    expect([...server.todos.values()][0]).toMatchObject({ text: 'Ship the panel', status: 'pending' });
  });

  test('retrying an add after the server commits but the response is lost reuses the requestId and never creates a second todo', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    server.failNextResponse('add');

    await user.type(screen.getByLabelText('Add a todo'), 'Retry me');
    await user.click(screen.getByRole('button', { name: 'Add todo' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot add the todo. Try again.'));

    // The server actually committed on the first (errored) attempt — proves this is a genuine
    // "response lost after commit" replay, not merely "the server never saw it".
    expect(server.todos.size).toBe(1);
    const committedId = [...server.todos.keys()][0];

    // Same intent (unchanged text) retried — must reuse the same idempotency key and resolve to
    // the SAME already-committed todo, not mint a second one.
    await user.click(screen.getByRole('button', { name: 'Add todo' }));
    await waitFor(() => expect(screen.getByText('Retry me')).toBeVisible());

    expect(server.requestIdsSeen).toHaveLength(2);
    expect(server.requestIdsSeen[0]).toBe(server.requestIdsSeen[1]);
    expect(server.todos.size).toBe(1);
    expect([...server.todos.keys()][0]).toBe(committedId);
  });

  test('toggling a todo sends the current expectedVersion and flips the accessible name', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Toggle me');

    const toggle = screen.getByRole('button', { name: 'Mark completed' });
    await user.click(toggle);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark not done' })).toBeVisible());
    const todo = [...server.todos.values()][0];
    expect(todo).toMatchObject({ status: 'completed', version: 1 });
  });

  test('when a toggle commits but the response is lost, the row self-heals to the committed state via the invalidated refetch, with no duplicate commit', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Toggle self-heal');
    const todoId = [...server.todos.keys()][0] as string;
    const requestsBeforeToggle = server.requestIdsSeen.length;
    server.failNextResponse('update');

    await user.click(screen.getByRole('button', { name: 'Mark completed' }));
    // The client sees an error, but the mutation already committed server-side. The endpoint
    // invalidates the plan query on every settle (success or failure), so the row converges to the
    // true committed state on its own — no user retry needed.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark not done' })).toBeVisible());

    expect(server.todos.get(todoId)).toMatchObject({ status: 'completed', version: 1 });
    // Exactly one update request landed — the lost-response failure was not silently retried or
    // duplicated into a second commit.
    expect(server.requestIdsSeen).toHaveLength(requestsBeforeToggle + 1);
    // The self-heal doesn't just fix the row — it must also clear the "try again" banner, or the
    // page keeps telling the user to retry an action that already succeeded.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('when a delete commits but the response is lost, the row self-heals (disappears) via the invalidated refetch, with no duplicate commit', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Delete self-heal');
    const requestsBeforeDelete = server.requestIdsSeen.length;
    server.failNextResponse('delete');

    await user.click(screen.getByRole('button', { name: 'Delete todo' }));
    await screen.findByText('Delete "Delete self-heal"? This cannot be undone.');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Delete self-heal')).toBeNull());
    expect(server.todos.size).toBe(0);
    // Exactly one delete request landed — the lost-response failure was not silently retried or
    // duplicated into a second commit.
    expect(server.requestIdsSeen).toHaveLength(requestsBeforeDelete + 1);
    // The self-heal doesn't just remove the row — it must also clear the "try again" banner, or the
    // page keeps telling the user to retry a delete that already succeeded.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('when a mutation genuinely fails (never lands), the error banner stays and the retry key is preserved', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Genuinely fails');
    const todoId = [...server.todos.keys()][0] as string;
    server.failNextRequest('update');

    await user.click(screen.getByRole('button', { name: 'Mark completed' }));

    // Unlike the self-heal cases above: nothing committed, so the row and the error both stay.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot update the todo. Try again.'));
    expect(screen.getByRole('button', { name: 'Mark completed' })).toBeVisible();
    expect(server.todos.get(todoId)).toMatchObject({ status: 'pending', version: 0 });

    // Retrying reuses the same requestId (the intent slot was never settled) and this time lands.
    const requestIdBeforeRetry = lastRequestId();
    await user.click(screen.getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark not done' })).toBeVisible());
    expect(lastRequestId()).toBe(requestIdBeforeRetry);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test("a failed toggle on one todo never poisons a different todo's requestId, even with the same target intent shape", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Task A');
    await addTodo(user, 'Task B');
    const rows = screen.getAllByRole('listitem');
    const rowA = within(rows[0] as HTMLElement);
    const rowB = within(rows[1] as HTMLElement);

    // A's toggle fails before ever reaching the store (nothing commits), so the self-heal refetch
    // confirms it did NOT land and the handler never calls `.settle()` on A's intent slot — it stays
    // populated with A's {status: 'completed'} intent, exactly the "still pending" state the old
    // shared single-slot design left behind. Under that OLD design (no per-todo scoping), B's click
    // below — a DIFFERENT todo but the SAME target intent shape — would incorrectly match A's
    // lingering slot and reuse A's requestId instead of minting its own.
    server.failNextRequest('update');
    await user.click(rowA.getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot update the todo. Try again.'));
    const requestIdA = lastRequestId();

    await user.click(rowB.getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(rowB.getByRole('button', { name: 'Mark not done' })).toBeVisible());
    const requestIdB = lastRequestId();

    expect(requestIdB).not.toBe(requestIdA);
    const todoB = [...server.todos.values()].find((todo) => todo.text === 'Task B');
    // B's flip landed exactly once, under its own independent key — A's failure left no trace.
    expect(todoB).toMatchObject({ status: 'completed', version: 1 });
  });

  test('a 409 version conflict on toggle shows a recoverable message and reconciles the row to server truth', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Conflict me');
    const todoId = [...server.todos.keys()][0] as string;
    // Simulate a concurrent writer bumping the version behind the UI's back.
    server.todos.set(todoId, { ...(server.todos.get(todoId) as FakeTodo), version: 5, status: 'in_progress' });

    await user.click(screen.getByRole('button', { name: 'Mark completed' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('This todo changed elsewhere. Showing the latest version.')
    );
    // The row shows the server's canonical status (in_progress), never a speculative "completed".
    await waitFor(() => expect(screen.getByText('In progress')).toBeVisible());
    expect(server.todos.get(todoId)).toMatchObject({ status: 'in_progress', version: 5 });
  });

  test('delete requires confirmation: cancel sends zero mutations, confirm removes the row', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Delete me');

    await user.click(screen.getByRole('button', { name: 'Delete todo' }));
    await screen.findByText('Delete "Delete me"? This cannot be undone.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Delete "Delete me"? This cannot be undone.')).toBeNull());
    expect(screen.getByText('Delete me')).toBeVisible();
    expect(server.todos.size).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Delete todo' }));
    await screen.findByText('Delete "Delete me"? This cannot be undone.');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Delete me')).toBeNull());
    expect(server.todos.size).toBe(0);
  });

  test('assigning a todo sends the canonical projectMemberId, and renaming the member updates the displayed name without a new request', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Assign me');

    const row = screen.getByRole('listitem');
    await user.click(within(row).getByLabelText('Assignee'));
    await user.click(await screen.findByRole('option', { name: 'Codex' }));

    await waitFor(() => {
      const todo = [...server.todos.values()][0];
      expect(todo?.assigneeProjectMemberId).toBe('pmem_codex000001');
    });
    const requestsBeforeRename = server.requestIdsSeen.length;

    // Stage the post-reconcile roster (what the daemon will have already committed by the time the
    // PATCH below responds), then drive an ACTUAL `updateWorkplaceProject` mutation through the
    // real RTK Query dispatch path — not a hand-rolled `invalidateTags` action — so this proves the
    // real production invalidation chain (`updateWorkplaceProject` → `ProjectRoster` tag → roster
    // query refetch) actually converges, not just that the UI re-renders when told to.
    (client as unknown as { __setRoster: (n: Array<{ id: string; displayName: string }>) => void }).__setRoster([
      { id: 'pmem_codex000001', displayName: 'Codex Renamed' }
    ]);
    await store.dispatch(
      updateWorkplaceProjectApi.endpoints.updateWorkplaceProject.initiate({ id: projectId, memberTemplates: [] })
    );

    await waitFor(() => expect(screen.getByText('Codex Renamed')).toBeVisible());
    // Display refreshed via a re-fetched roster lookup; the wire identity (pmid) and mutation
    // count are untouched by the rename — nothing was sent to reassign the todo.
    expect(server.requestIdsSeen).toHaveLength(requestsBeforeRename);
    expect([...server.todos.values()][0]?.assigneeProjectMemberId).toBe('pmem_codex000001');
  });

  test('the assignee Select is locked while a mutation on the same todo is in flight, and a second attempt sends nothing', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Lock me while pending');
    // Re-query the row/trigger fresh at each step instead of holding one reference across the
    // pause/resume gap — a held reference can't tell a genuine re-render (new node, same key) from
    // stale-DOM pollution leaking in from another test, so re-querying is the robust way to assert
    // "the currently rendered trigger" at each point in time.
    const assigneeTrigger = () => within(screen.getByRole('listitem')).getByLabelText('Assignee');

    (client as unknown as { __pausePatch: () => void }).__pausePatch();
    // `markPending` runs synchronously inside the click handler, before the (now-paused) mutation
    // promise is awaited — so by the time `user.click` itself settles (it only waits for its own
    // synthetic event dispatch and React's resulting commit, never for an unrelated async
    // continuation the handler kicked off), the pending state is already committed. Await it fully
    // instead of polling with `waitFor`: repeatedly re-querying while a paused/gated promise is
    // outstanding elsewhere in the same test process proved flaky (intermittently resolving to a
    // disconnected node) in exactly this file.
    await user.click(within(screen.getByRole('listitem')).getByRole('button', { name: 'Mark completed' }));
    expect(assigneeTrigger()).toBeDisabled();

    const requestsWhilePending = server.requestIdsSeen.length;
    // A disabled Radix trigger doesn't open on click — this proves it structurally, not just by
    // checking the `disabled` attribute: the attempt produces no request and no option list.
    fireEvent.click(assigneeTrigger());
    expect(screen.queryByRole('option', { name: 'Codex' })).toBeNull();
    expect(server.requestIdsSeen).toHaveLength(requestsWhilePending);

    (client as unknown as { __resumePatch: () => void }).__resumePatch();
    await waitFor(() => expect(assigneeTrigger()).not.toBeDisabled());
  }, 30_000);

  test('a todo assigned to a disabled/former project member still shows their real name, never "Unassigned"', async () => {
    client = clientOverPlanServer(server, [
      { id: 'pmem_left0000001', displayName: 'Left member', lifecycle: 'disabled' }
    ]);
    store = createMonadStore({ client });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No todos yet');
    await addTodo(user, 'Assigned to a left member');

    // Directly assign the durable todo to the disabled member (they're not offered in the
    // reassignment dropdown since they're no longer a legal assignment target, but a todo can
    // already carry their id from before they were disabled).
    const todoId = [...server.todos.keys()][0] as string;
    server.todos.set(todoId, {
      ...(server.todos.get(todoId) as FakeTodo),
      assigneeProjectMemberId: 'pmem_left0000001'
    });
    store.dispatch({ type: 'monadApi/invalidateTags', payload: [{ type: 'SessionPlan', id: sessionId }] });

    // Never collapses to "Unassigned" — the durable pmid resolves through the full roster
    // (which, unlike the live session-member list, still includes disabled members).
    await waitFor(() => expect(screen.getByText('Left member')).toBeVisible());
    expect(screen.queryByText('Unassigned')).toBeNull();
  });
});
