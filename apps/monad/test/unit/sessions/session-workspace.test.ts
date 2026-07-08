import type { Session, SessionId } from '@monad/protocol';
import type { Agent } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newId } from '@monad/protocol';

import { createSessionContext } from '#/handlers/session/context.ts';
import { createLifecycleHandlers } from '#/handlers/session/handlers/lifecycle/index.ts';
import { EventBus } from '#/services/event-bus.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { createStore } from '#/store/db/index.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'monad-ws-'));

function fixtureSession(over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'room',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

/** Build lifecycle handlers over a real store with direct access to the internal runtime map, so a
 *  test can assert the sandbox-root broadening that drives delegated-subagent inheritance. `agent` is
 *  never touched by setWorkspace/update — only create/branch use it — so a bare stub is enough. */
function lifecycleCtx() {
  const store = createStore();
  const ctx = createSessionContext({
    store,
    agent: {} as Agent,
    bus: new EventBus(),
    cache: new RoundCache(),
    ownerPrincipalId: newId('prn')
  });
  return { store, ctx, handlers: createLifecycleHandlers(ctx) };
}

test('setWorkspace persists the working folder and clears it on an empty path', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'room' });
  const dir = tmpDir();

  const set = await h.session.setWorkspace({ id: sessionId as SessionId, cwd: dir });
  expect(set.cwd).toBe(dir);
  expect(h.store.getSession(sessionId)?.cwd).toBe(dir);

  const _cleared = await h.session.setWorkspace({ id: sessionId as SessionId, cwd: '' });
  h.store.close();
});

test('setWorkspace rejects a relative path, a missing dir, and a file', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'room' });
  const dir = tmpDir();
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'x');

  expect(h.session.setWorkspace({ id: sessionId as SessionId, cwd: 'relative/path' })).rejects.toThrow();
  expect(h.session.setWorkspace({ id: sessionId as SessionId, cwd: join(dir, 'nope') })).rejects.toThrow();
  expect(h.session.setWorkspace({ id: sessionId as SessionId, cwd: file })).rejects.toThrow();
  // A rejected set leaves the session unchanged.
  h.store.close();
});

test('update with cwd persists the folder; create with cwd seeds it', async () => {
  const h = buildHandlers(mockModel());
  const dir = tmpDir();

  const { sessionId } = await h.session.create({ title: 'room' });
  await h.session.update({ id: sessionId as SessionId, cwd: dir });
  expect(h.store.getSession(sessionId)?.cwd).toBe(dir);

  const created = await h.session.create({ title: 'room2', cwd: dir });
  expect(h.store.getSession(created.sessionId)?.cwd).toBe(dir);
  h.store.close();
});

test('setWorkspace broadens the runtime sandbox roots to the folder (so delegated subagents reach it)', async () => {
  const { store, ctx, handlers } = lifecycleCtx();
  const s = fixtureSession();
  store.insertSession(s);
  const dir = tmpDir();

  await handlers.setWorkspace({ id: s.id as SessionId, cwd: dir });
  // rt.sandboxRoots is what the loop passes down to delegated subagents (ctx.sandboxRoots).
  expect(ctx.runtime.get(s.id as SessionId)?.sandboxRoots).toEqual([dir]);

  await handlers.setWorkspace({ id: s.id as SessionId, cwd: '' });
  store.close();
});

test('setWorkspace resolves the path and preserves existing runtime config (MCP tools survive)', async () => {
  const { store, ctx, handlers } = lifecycleCtx();
  const s = fixtureSession();
  store.insertSession(s);
  // Pre-seed an out-of-band runtime entry (as the ACP bridge / session MCP wiring would).
  const sentinelTool = { name: 'mcp_sentinel' } as never;
  ctx.runtime.set(s.id as SessionId, { extraTools: [sentinelTool] });

  const dir = tmpDir();
  await handlers.setWorkspace({ id: s.id as SessionId, cwd: join(dir, '.', 'sub', '..') });
  const rt = ctx.runtime.get(s.id as SessionId);
  expect(rt?.sandboxRoots).toEqual([resolve(dir)]); // normalized, not the raw '/x/./sub/..'
  expect(rt?.extraTools).toEqual([sentinelTool]); // merge did not drop the MCP tool
  store.close();
});

test('setWorkspace expands a leading ~ to the home directory', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'room' });
  const set = await h.session.setWorkspace({ id: sessionId as SessionId, cwd: '~' });
  expect(set.cwd).toBe(homedir());
  h.store.close();
});

test('setWorkspace resolves a relative path against the session’s current folder', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'room' });
  const base = tmpDir();
  mkdirSync(join(base, 'sub'));

  await h.session.setWorkspace({ id: sessionId as SessionId, cwd: base });
  // 'sub' is relative → resolves against the current folder (base), not rejected.
  const set = await h.session.setWorkspace({ id: sessionId as SessionId, cwd: 'sub' });
  expect(set.cwd).toBe(join(base, 'sub'));
  h.store.close();
});

test('workspaceMeta wraps the git summary and workspaceGit remains a git-only alias', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'room', cwd: tmpDir() });

  await expect(h.session.workspaceMeta({ id: sessionId as SessionId })).resolves.toEqual({
    git: { isRepo: false }
  });
  await expect(h.session.workspaceGit({ id: sessionId as SessionId })).resolves.toEqual({ isRepo: false });
  h.store.close();
});

test('switching/clearing the folder drops the prior folder’s project skills (no stale carry-over)', async () => {
  const { store, ctx, handlers } = lifecycleCtx();
  const s = fixtureSession();
  store.insertSession(s);
  // Simulate skills loaded from a prior working folder plus an unrelated MCP tool.
  const staleSkill = { name: 'stale_skill' } as never;
  const mcpTool = { name: 'mcp_tool' } as never;
  ctx.runtime.set(s.id as SessionId, { extraSkills: [staleSkill], extraTools: [mcpTool] });

  // No discoverProjectSkills wired → the new folder contributes no skills; the stale ones must go.
  await handlers.setWorkspace({ id: s.id as SessionId, cwd: tmpDir() });
  expect(ctx.runtime.get(s.id as SessionId)?.extraTools).toEqual([mcpTool]); // MCP tools still survive

  store.close();
});
