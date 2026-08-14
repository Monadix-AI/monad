// P0 conformance fixture — the vertical acceptance scenario for "Monad is a headless-local-first
// agent team runtime" (docs/internal/proposals/headless-runtime-mesh-engine-priorities.md).
//
// Every P0 slice (α → β → γ, Plan A) re-runs this same scenario; later slices extend it in place
// rather than adding a parallel one. Only cases that run red→green today live here — the remaining
// acceptance assertions are tracked in the plan checklist, not as pending cases in this file.
//
// Runs over BOTH transports (TCP + Unix), per the all-transports rule in AGENTS.md.

import type { MonadPaths } from '@monad/environment';
import type { MeshSessionId, ProjectId, SessionId } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';
import { listSessionMembersResponseSchema } from '@monad/protocol';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

const S5_AGENT_TOKEN = 's5-conformance-agent-token';
const s5TokenHash = (token = S5_AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

function s5BindingHeaders(meshSessionId: MeshSessionId): Record<string, string> {
  return { authorization: `Bearer ${S5_AGENT_TOKEN}`, 'x-monad-mesh-session-id': meshSessionId };
}

// Wires an already-canonical ProjectMember's EXISTING binding in one session to a live managed
// runtime — unlike native-agent-cli-bridge.test.ts's `createManagedNativeSession`, this never mints
// a member; it is used when the same member is deliberately bound into more than one session and
// only one of those bindings should own a runtime.
function s5AttachManagedRuntime(
  handlers: ReturnType<typeof buildHandlers>,
  sessionId: SessionId,
  projectMemberId: string,
  meshSessionId: MeshSessionId,
  agentName: string,
  workingPath: string
): void {
  const at = '2026-07-29T00:00:00.000Z';
  handlers.store.upsertMeshSession({
    id: meshSessionId,
    transcriptTargetId: sessionId,
    agentName,
    provider: agentName === 'claude' ? 'claude-code' : 'codex',
    workingPath,
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: meshSessionId,
    agentRuntimeTokenHash: s5TokenHash(),
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: at,
    updatedAt: at,
    exitedAt: null
  });
  handlers.store.replaceSessionBindingRuntime({
    sessionId,
    projectMemberId,
    currentNativeRuntimeSessionId: meshSessionId,
    updatedAt: at
  });
}

for (const kind of TRANSPORTS) {
  describe(`headless agent-team conformance over ${kind}`, () => {
    let t: TransportHandle;

    beforeEach(() => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(['ack']))));
    });
    afterEach(async () => {
      await t.stop();
    });

    const json = (method: string, path: string, body?: unknown) =>
      t.fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    async function createProject(title: string): Promise<string> {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title })).json()) as {
        projectId: string;
      };
      return projectId;
    }

    async function createProjectSession(projectId: string, title: string): Promise<string> {
      const res = await json('POST', `/v1/projects/${projectId}/sessions`, { title });
      expect(res.status).toBe(201);
      const { sessionId } = (await res.json()) as { sessionId: string };
      return sessionId;
    }

    async function addMember(sessionId: string, type: 'monad' | 'mesh-agent', name: string): Promise<string> {
      const { member } = (await (await json('POST', `/v1/sessions/${sessionId}/members`, { type, name })).json()) as {
        member: { id: string };
      };
      return member.id;
    }

    type MemberBinding = {
      member: Record<string, unknown>;
      binding: Record<string, unknown>;
    };
    const stripTimestamps = <T extends Record<string, unknown>>(value: T): Omit<T, 'createdAt' | 'updatedAt'> => {
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value;
      return rest;
    };

    const bind = (sessionId: string, projectMemberId: string) =>
      json('PUT', `/v1/sessions/${sessionId}/members/${projectMemberId}`);
    async function bindMember(sessionId: string, projectMemberId: string): Promise<MemberBinding> {
      const res = await bind(sessionId, projectMemberId);
      expect(res.status).toBe(200);
      return (await res.json()) as MemberBinding;
    }
    const removeMember = (sessionId: string, memberId: string) =>
      json('DELETE', `/v1/sessions/${sessionId}/members/${memberId}`);
    async function addMemberWithSettings(
      sessionId: string,
      name: string,
      settings: Record<string, unknown>
    ): Promise<string> {
      const { member } = (await (
        await json('POST', `/v1/sessions/${sessionId}/members`, { type: 'mesh-agent', name, settings })
      ).json()) as { member: { id: string } };
      return member.id;
    }

    test('a project session hosts two distinct provider-backed members', async () => {
      const projectId = await createProject('two-provider');
      const sessionId = await createProjectSession(projectId, 'collab');
      const codex = await addMember(sessionId, 'mesh-agent', 'codex');
      const claude = await addMember(sessionId, 'mesh-agent', 'claude-code');

      expect(codex).not.toBe(claude);
      // Strict-parse the canonical list: each entry is a `{ member, binding }` join. The two spawned
      // members carry their profileId as the mesh-agent name, are distinct, and each self-binds active.
      const listed = listSessionMembersResponseSchema.parse(
        await (await t.fetch(`/v1/sessions/${sessionId}/members`)).json()
      );
      expect(
        listed.members
          .map((entry) => ({
            profileId: entry.member.profileId,
            selfBound: entry.binding.projectMemberId === entry.member.id,
            lifecycle: entry.binding.lifecycle
          }))
          .sort((a, b) => a.profileId.localeCompare(b.profileId))
      ).toEqual([
        { profileId: 'claude-code', selfBound: true, lifecycle: 'active' },
        { profileId: 'codex', selfBound: true, lifecycle: 'active' }
      ]);
    });

    test('a spawned project member is canonical identity and binds independently into multiple sessions', async () => {
      const projectId = await createProject('bind-identity');
      const sessionA = await createProjectSession(projectId, 'A');
      // A successful spawn mints a persistent project member and its active binding in session A.
      const memberId = await addMember(sessionA, 'mesh-agent', 'codex');
      const sessionB = await createProjectSession(projectId, 'B');

      const boundToB = await bindMember(sessionB, memberId);
      expect(stripTimestamps(boundToB.member)).toEqual({
        id: memberId,
        projectId,
        profileId: 'codex',
        type: 'mesh-agent',
        displayName: 'codex',
        customPrompt: null,
        launchOverrides: {},
        workingDirectoryOverride: null,
        lifecycle: 'enabled'
      });
      expect(stripTimestamps(boundToB.binding)).toEqual({
        sessionId: sessionB,
        projectMemberId: memberId,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        currentNativeRuntimeSessionId: null,
        lifecycle: 'active',
        lastHealth: null
      });

      // Idempotent: re-binding returns the same binding row (identical createdAt), never a duplicate.
      const rebound = await bindMember(sessionB, memberId);
      expect(rebound.binding.createdAt).toBe(boundToB.binding.createdAt);

      // The same member's binding in session A (minted at spawn) is a distinct row scoped to A.
      const boundToA = await bindMember(sessionA, memberId);
      expect(boundToA.binding.sessionId).toBe(sessionA);
      expect(boundToA.member.id).toBe(memberId);
      expect(boundToA.binding.sessionId).not.toBe(boundToB.binding.sessionId);

      // Binding an unknown project member is a not-found, not a silent create.
      expect((await bind(sessionB, 'pmem_does_not_exist')).status).toBe(404);
    });

    test('each spawn of the same profile mints an independent project member', async () => {
      const projectId = await createProject('two-instances');
      const sessionId = await createProjectSession(projectId, 'collab');
      const first = await addMember(sessionId, 'mesh-agent', 'codex');
      const second = await addMember(sessionId, 'mesh-agent', 'codex');
      expect(first).not.toBe(second);
      // Both are real, independently bindable identities.
      const firstBinding = await bindMember(sessionId, first);
      const secondBinding = await bindMember(sessionId, second);
      expect(firstBinding.member.profileId).toBe('codex');
      expect(secondBinding.member.profileId).toBe('codex');
      expect(firstBinding.member.id).not.toBe(secondBinding.member.id);
    });

    test('a left binding is a stable conflict on re-bind, never a silent rejoin', async () => {
      const projectId = await createProject('left-conflict');
      const sessionId = await createProjectSession(projectId, 'A');
      const memberId = await addMember(sessionId, 'mesh-agent', 'codex');

      const before = await bindMember(sessionId, memberId);
      expect((await removeMember(sessionId, memberId)).status).toBe(200);

      // Re-binding a member that has left is a 409 conflict — not a silent reactivation.
      const reboundRes = await bind(sessionId, memberId);
      expect(reboundRes.status).toBe(409);
      // The member identity outlives the left binding: it can still be bound into a fresh session.
      const sessionB = await createProjectSession(projectId, 'B');
      const boundToB = await bindMember(sessionB, memberId);
      expect(boundToB.member.id).toBe(memberId);
      expect(boundToB.binding.createdAt).not.toBe(before.binding.createdAt);
    });

    test('a member bound purely through PUT (no legacy row) can still be left via DELETE', async () => {
      const projectId = await createProject('canonical-delete');
      const sessionA = await createProjectSession(projectId, 'A');
      const memberId = await addMember(sessionA, 'mesh-agent', 'codex');
      const sessionB = await createProjectSession(projectId, 'B');
      await bindMember(sessionB, memberId);

      // DELETE resolves the member by its SessionBinding even though session B has no legacy row.
      expect((await removeMember(sessionB, memberId)).status).toBe(200);
      // The binding is now left, so a re-bind is the stable conflict.
      expect((await bind(sessionB, memberId)).status).toBe(409);
      // Session A's binding is untouched and still active.
      const boundA = await bindMember(sessionA, memberId);
      expect(boundA.binding.sessionId).toBe(sessionA);
      expect(boundA.binding.lifecycle).toBe('active');
    });

    test('a spawned member projects its settings into the canonical member fields', async () => {
      const projectId = await createProject('settings-projection');
      const sessionId = await createProjectSession(projectId, 'A');
      const memberId = await addMemberWithSettings(sessionId, 'codex', {
        cwd: '/tmp/work',
        customPrompt: 'be terse',
        modelName: 'gpt-x'
      });
      const bound = await bindMember(sessionId, memberId);
      expect(bound.member.workingDirectoryOverride).toBe('/tmp/work');
      expect(bound.member.customPrompt).toBe('be terse');
      // launchOverrides keeps the rest but omits cwd/customPrompt (those have dedicated fields).
      expect(bound.member.launchOverrides).toEqual({ modelName: 'gpt-x' });
    });

    test('inviting one template into two sessions mints two distinct members sharing a profile', async () => {
      const projectId = await createProject('invite-identity');
      await json('PATCH', `/v1/workplace/projects/${projectId}`, {
        memberTemplates: [{ id: 'tmpl-codex', type: 'mesh-agent', name: 'codex' }]
      });
      const sessionA = await createProjectSession(projectId, 'A');
      const sessionB = await createProjectSession(projectId, 'B');
      const invite = async (sessionId: string) =>
        (
          (await (await json('POST', `/v1/sessions/${sessionId}/members`, { templateId: 'tmpl-codex' })).json()) as {
            member: { id: string };
          }
        ).member.id;

      const a1 = await invite(sessionA);
      const a2 = await invite(sessionA);
      const b1 = await invite(sessionB);
      // Same-session re-invite is idempotent (one member); another session is a distinct member.
      expect(a1).toBe(a2);
      expect(a1).not.toBe(b1);
      expect(a1).toMatch(/^pmem_/);

      // Both are independent canonical identities that reference the same Profile (template).
      const boundA = await bindMember(sessionA, a1);
      const boundB = await bindMember(sessionB, b1);
      expect(boundA.member.profileId).toBe('tmpl-codex');
      expect(boundB.member.profileId).toBe('tmpl-codex');
      expect(boundA.binding.sessionId).toBe(sessionA);
      expect(boundB.binding.sessionId).toBe(sessionB);
    });

    test('a template PATCH leaves an existing canonical member and binding unchanged', async () => {
      const projectId = await createProject('template-reconcile');
      const setTemplate = (tpl: Record<string, unknown>) =>
        json('PATCH', `/v1/workplace/projects/${projectId}`, { memberTemplates: [tpl] });
      expect(
        (
          await setTemplate({
            id: 'tmpl-codex',
            type: 'mesh-agent',
            name: 'codex',
            displayName: 'Codex',
            settings: { customPrompt: 'be terse', cwd: '/tmp/a', modelName: 'gpt-x' }
          })
        ).status
      ).toBe(200);
      const sessionId = await createProjectSession(projectId, 'A');
      const invited = (await (
        await json('POST', `/v1/sessions/${sessionId}/members`, { templateId: 'tmpl-codex' })
      ).json()) as { member: { id: string } };
      const memberId = invited.member.id;
      const before = await bindMember(sessionId, memberId);
      expect(stripTimestamps(before.member)).toEqual({
        id: memberId,
        projectId,
        profileId: 'tmpl-codex',
        type: 'mesh-agent',
        displayName: 'Codex',
        customPrompt: 'be terse',
        workingDirectoryOverride: '/tmp/a',
        launchOverrides: { modelName: 'gpt-x' },
        lifecycle: 'enabled'
      });

      // Re-PATCH the same template with new displayName, type, and settings.
      expect(
        (
          await setTemplate({
            id: 'tmpl-codex',
            type: 'acp',
            name: 'codex',
            displayName: 'Renamed',
            settings: { customPrompt: 'be verbose', cwd: '/tmp/b', modelName: 'gpt-y' }
          })
        ).status
      ).toBe(200);

      const after = await bindMember(sessionId, memberId);
      expect(after.member).toEqual(before.member);
      expect(after.binding).toEqual(before.binding);
    });

    test('spawn requires the session to be bound to a project', async () => {
      const created = (await (await json('POST', '/v1/sessions', { title: 'loose' })).json()) as {
        sessionId?: string;
        session?: { id: string };
      };
      const looseSession = created.sessionId ?? created.session?.id ?? '';
      const res = await json('POST', `/v1/sessions/${looseSession}/members`, { type: 'mesh-agent', name: 'codex' });
      expect(res.status).toBe(400);
    });
  });

  // S5 — the global P0 conformance pass: a stable ProjectMember shared across two sessions with
  // independent delivery cursors, a real restart with no re-delivery, two providers in one project
  // session over a shared workspace with no cross-routing, and (via the outer `for (const kind of
  // TRANSPORTS)` loop every case in this file already runs inside) TCP/Unix transport parity.
  describe(`S5 global P0 conformance over ${kind}`, () => {
    let t: TransportHandle;
    let handlers: ReturnType<typeof buildHandlers>;

    beforeEach(() => {
      handlers = buildHandlers(mockModel(['ack']));
      t = serveTransport(kind, createHttpTransport(handlers));
    });
    afterEach(async () => {
      await t.stop();
    });

    const json = (method: string, path: string, body?: unknown) =>
      t.fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    async function createProject(title: string): Promise<ProjectId> {
      const { projectId } = (await (await json('POST', '/v1/workplace/projects', { title })).json()) as {
        projectId: ProjectId;
      };
      return projectId;
    }
    async function createProjectSession(projectId: ProjectId, title: string, cwd?: string): Promise<SessionId> {
      const res = await json('POST', `/v1/projects/${projectId}/sessions`, { title, ...(cwd ? { cwd } : {}) });
      expect(res.status).toBe(201);
      const { sessionId } = (await res.json()) as { sessionId: SessionId };
      return sessionId;
    }
    async function addMember(sessionId: SessionId, name: string): Promise<string> {
      const { member } = (await (
        await json('POST', `/v1/sessions/${sessionId}/members`, { type: 'mesh-agent', name })
      ).json()) as { member: { id: string } };
      return member.id;
    }
    async function bindMember(sessionId: SessionId, projectMemberId: string): Promise<void> {
      expect((await json('PUT', `/v1/sessions/${sessionId}/members/${projectMemberId}`)).status).toBe(200);
    }

    test("a member's delivery cursor advances only in the session that received traffic — a sibling binding in another session is untouched", async () => {
      const projectId = await createProject('s5-independent-cursors');
      const sessionA = await createProjectSession(projectId, 'A');
      const sessionB = await createProjectSession(projectId, 'B');
      const memberId = await addMember(sessionA, 'codex');
      await bindMember(sessionB, memberId);

      // Both bindings genuinely start at the same zero watermark before any traffic.
      expect(handlers.store.getSessionBinding(sessionA, memberId)).toMatchObject({
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0
      });
      expect(handlers.store.getSessionBinding(sessionB, memberId)).toMatchObject({
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0
      });

      // Only session A's binding gets a live runtime; drive a real project post through the public
      // native-agent HTTP surface, the same path a real managed CLI agent uses to self-consume its
      // own post (apps/monad/src/services/native-agent/project.ts).
      const meshSessionId = 'mesh_s5cursorA001' as MeshSessionId;
      s5AttachManagedRuntime(handlers, sessionA, memberId, meshSessionId, 'codex', '/tmp/s5-workspace');
      const res = await t.fetch('/v1/internal/native-agent/project/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...s5BindingHeaders(meshSessionId) },
        body: JSON.stringify({ requestId: 'req_s5_cursor_post1', sessionId: sessionA, text: 'hello from A' })
      });
      expect(res.status).toBe(200);

      // Session A's own binding advanced (self-consume on post — markMeshAgentInboxConsumed).
      const afterA = handlers.store.getSessionBinding(sessionA, memberId);
      expect(afterA?.lastVisibleSeq).toBeGreaterThan(0);
      // Session B's binding for the SAME canonical member is untouched — proves the cursor lives on
      // the (session, member) binding, never on the member identity itself.
      expect(handlers.store.getSessionBinding(sessionB, memberId)).toMatchObject({
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0
      });
    });

    test('two different providers share one project session and one workspace, with no cross-routing of a private message onto the shared wall', async () => {
      // The daemon validates a session's cwd exists on disk at creation time — a real directory, not
      // a placeholder path.
      const sharedCwd = await mkdtemp(join(tmpdir(), 'monad-s5-shared-workspace-'));
      try {
        const projectId = await createProject('s5-two-providers');
        const sessionId = await createProjectSession(projectId, 'collab', sharedCwd);
        const codexId = await addMember(sessionId, 'codex');
        const claudeId = await addMember(sessionId, 'claude-code');
        const codexMesh = 'mesh_s5provCodex1' as MeshSessionId;
        const claudeMesh = 'mesh_s5provClaud1' as MeshSessionId;
        s5AttachManagedRuntime(handlers, sessionId, codexId, codexMesh, 'codex', sharedCwd);
        s5AttachManagedRuntime(handlers, sessionId, claudeId, claudeMesh, 'claude', sharedCwd);

        // Both providers genuinely operate over the SAME session workspace root, not independent sandboxes.
        expect(handlers.store.getMeshSession(codexMesh)?.workingPath).toBe(sharedCwd);
        expect(handlers.store.getMeshSession(claudeMesh)?.workingPath).toBe(sharedCwd);

        // Codex posts to the shared wall — both providers' presence in one session doesn't merge their
        // identities; the post is attributed to codex's own canonical member.
        const wallPost = await t.fetch('/v1/internal/native-agent/project/post', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...s5BindingHeaders(codexMesh) },
          body: JSON.stringify({ requestId: 'req_s5_wall_post1', sessionId, text: 'status update for the room' })
        });
        expect(wallPost.status).toBe(200);

        // Codex also sends claude a PRIVATE message — this must never leak onto the shared session wall.
        const dmSent = await t.fetch('/v1/internal/native-agent/agent/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...s5BindingHeaders(codexMesh) },
          body: JSON.stringify({ requestId: 'req_s5_dm_send1', to: claudeId, text: 'just between us' })
        });
        expect(dmSent.status).toBe(200);

        // Claude can read the DM through its own private ledger…
        const dmRead = await t.fetch('/v1/internal/native-agent/agent/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...s5BindingHeaders(claudeMesh) },
          body: JSON.stringify({ with: codexId })
        });
        expect(dmRead.status).toBe(200);
        expect(
          ((await dmRead.json()) as { messages: Array<{ fromAgent: string; text: string }> }).messages
        ).toMatchObject([{ fromAgent: codexId, text: 'just between us' }]);

        // …but the shared session transcript records only the public post and the content-free DM audit
        // receipt, never the private body — proving routing isolation between the two providers.
        const roomMessages = await t.fetch(`/v1/sessions/${sessionId}/messages`);
        const roomTexts = ((await roomMessages.json()) as { messages: Array<{ text: string }> }).messages.map(
          (message) => message.text
        );
        expect(roomTexts).toEqual(['status update for the room', 'codex sent claude-code a DM.']);
      } finally {
        await rm(sharedCwd, { recursive: true, force: true });
      }
    });

    test('durable delivery state survives a real file-backed restart, observed through the HTTP surface — no re-delivery, no cursor rewind', async () => {
      const dbPath = join(tmpdir(), `monad-s5-restart-${process.hrtime.bigint()}.sqlite`);
      const cleanup = () => {
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
      };
      let firstTransport: TransportHandle | undefined;
      let secondTransport: TransportHandle | undefined;
      let reopenedStore: ReturnType<typeof createStore> | undefined;
      try {
        const firstStore = createStore({ path: dbPath });
        const firstHandlers = buildHandlers(mockModel(['ack']), undefined, { store: firstStore });
        firstTransport = serveTransport(kind, createHttpTransport(firstHandlers));

        const projectRes = await firstTransport.fetch('/v1/workplace/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 's5-restart' })
        });
        const { projectId } = (await projectRes.json()) as { projectId: string };
        const sessionRes = await firstTransport.fetch(`/v1/projects/${projectId}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 's5-restart-session' })
        });
        const { sessionId } = (await sessionRes.json()) as { sessionId: string };
        const memberRes = await firstTransport.fetch(`/v1/sessions/${sessionId}/members`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'mesh-agent', name: 'codex' })
        });
        const { member } = (await memberRes.json()) as { member: { id: string } };

        const meshSessionId = 'mesh_s5restartA01' as MeshSessionId;
        s5AttachManagedRuntime(
          firstHandlers,
          sessionId as SessionId,
          member.id,
          meshSessionId,
          'codex',
          '/tmp/s5-restart'
        );
        // Deliver + mark visible + consume, mirroring the daemon's own durable-inbox lifecycle
        // (managed-inbox-restart.test.ts's established direct-store seeding — there is no HTTP
        // trigger for a peer's delivered/visible advance today; see that file's header for why).
        firstHandlers.store.enqueueMeshAgentInboxItem(meshSessionId, 1, { deliveryId: 'deliv_s5restart01' });
        firstHandlers.store.markMeshAgentInboxDelivered(meshSessionId, 1);
        firstHandlers.store.markMeshAgentInboxVisible(meshSessionId, 1);
        firstHandlers.store.markMeshAgentInboxConsumed(meshSessionId, 1);

        const beforeBinding = firstHandlers.store.getSessionBinding(sessionId as SessionId, member.id);
        const beforeMembersRes = await firstTransport.fetch(`/v1/sessions/${sessionId}/members`);
        const beforeMembers = listSessionMembersResponseSchema.parse(await beforeMembersRes.json());

        await firstTransport.stop();
        firstStore.close();

        // ── Real restart: reopen the SAME file, run the exact production boot-reconcile order ──
        reopenedStore = createStore({ path: dbPath });
        reopenedStore.reconcileOrphanedMeshSessions(() => {});
        const firstReconcile = reopenedStore.reconcileSessionBindingRuntimesAfterRestart();
        // A second reconcile pass (idempotent no-op) proves the first pass didn't leave anything to
        // re-recover — the established "double reconcile" idiom from
        // apps/monad/test/unit/store/session-bindings.test.ts.
        const secondReconcile = reopenedStore.reconcileSessionBindingRuntimesAfterRestart();
        expect(secondReconcile.recovered).toBe(0);

        const secondHandlers = buildHandlers(mockModel(['ack']), undefined, { store: reopenedStore });
        secondTransport = serveTransport(kind, createHttpTransport(secondHandlers));

        const afterBinding = reopenedStore.getSessionBinding(sessionId as SessionId, member.id);
        const afterMembersRes = await secondTransport.fetch(`/v1/sessions/${sessionId}/members`);
        const afterMembers = listSessionMembersResponseSchema.parse(await afterMembersRes.json());

        // The delivery watermark survives the restart untouched — no rewind, no re-delivery signal.
        // Boot reconcile legitimately clears the runtime pointer/health for the old pid, since that
        // process is gone; that reconciliation is not a cursor rewind, so scope the equality to the
        // durable delivery fields rather than the whole binding row.
        expect(afterBinding?.lastDeliveredSeq).toBe(beforeBinding?.lastDeliveredSeq);
        expect(afterBinding?.lastVisibleSeq).toBe(beforeBinding?.lastVisibleSeq);
        expect(afterBinding?.currentNativeRuntimeSessionId).toBeNull();
        expect(afterBinding?.lastHealth).toBe('stopped');
        // The same canonical roster is visible through the real HTTP surface before and after the
        // restart, modulo the same legitimate runtime-pointer/health reconciliation asserted above —
        // an HTTP client sees no OTHER difference except this being a fresh process.
        const normalizeMembers = (response: typeof beforeMembers) =>
          response.members.map(({ binding, ...rest }) => ({
            ...rest,
            binding: { ...binding, currentNativeRuntimeSessionId: null, lastHealth: 'stopped', updatedAt: null }
          }));
        expect(normalizeMembers(afterMembers)).toEqual(normalizeMembers(beforeMembers));
        expect(firstReconcile.recovered).toBeGreaterThanOrEqual(0);
      } finally {
        await firstTransport?.stop().catch(() => {});
        await secondTransport?.stop().catch(() => {});
        reopenedStore?.close();
        if (process.platform !== 'win32') cleanup();
      }
    });

    test('a managed agent mutating the durable SessionPlan never starts a model turn for either provider in the room', async () => {
      // Swap in a spy-wrapped model before any traffic — a single shared router serving BOTH
      // providers' runtimes, so a zero call count after the mutation rules out either one being
      // woken, not just the one that issued the request.
      await t.stop();
      const spy = { stream: 0, complete: 0 };
      const inner = mockModel(['ack']);
      handlers = buildHandlers({
        async *stream(req) {
          spy.stream++;
          yield* inner.stream(req);
        },
        async complete(req) {
          spy.complete++;
          return inner.complete(req);
        }
      });
      t = serveTransport(kind, createHttpTransport(handlers));

      const sharedCwd = await mkdtemp(join(tmpdir(), 'monad-s5-plan-workspace-'));
      try {
        const projectId = await createProject('s5-plan-no-wake');
        const sessionId = await createProjectSession(projectId, 'plan-room', sharedCwd);
        const codexId = await addMember(sessionId, 'codex');
        const claudeId = await addMember(sessionId, 'claude-code');
        const codexMesh = 'mesh_s5planCodex1' as MeshSessionId;
        const claudeMesh = 'mesh_s5planClaud1' as MeshSessionId;
        s5AttachManagedRuntime(handlers, sessionId, codexId, codexMesh, 'codex', sharedCwd);
        s5AttachManagedRuntime(handlers, sessionId, claudeId, claudeMesh, 'claude', sharedCwd);

        // Snapshot every delivery/fan-out surface for BOTH members before the mutation — a model-call
        // spy alone can't rule out the plan event being incorrectly routed into project fan-out and
        // sitting unconsumed in a runtime's durable ingress/inbox (no live host is attached here to
        // drain one), so this must be an explicit before/after diff on the real delivery state, not an
        // absence-only check.
        const deliverySnapshot = () => ({
          pendingIngressTargets: handlers.store.listPendingNativeAgentIngressTargets(),
          codexProjectInbox: handlers.store.listNativeAgentProjectInbox(projectId, sessionId, codexId),
          claudeProjectInbox: handlers.store.listNativeAgentProjectInbox(projectId, sessionId, claudeId),
          codexMeshInbox: handlers.store.listMeshAgentInbox(codexMesh),
          claudeMeshInbox: handlers.store.listMeshAgentInbox(claudeMesh),
          codexBinding: handlers.store.getSessionBinding(sessionId, codexId),
          claudeBinding: handlers.store.getSessionBinding(sessionId, claudeId)
        });
        const before = deliverySnapshot();
        expect(before).toEqual({
          pendingIngressTargets: [],
          codexProjectInbox: [],
          claudeProjectInbox: [],
          codexMeshInbox: [],
          claudeMeshInbox: [],
          codexBinding: expect.objectContaining({ lastDeliveredSeq: 0, lastVisibleSeq: 0 }),
          claudeBinding: expect.objectContaining({ lastDeliveredSeq: 0, lastVisibleSeq: 0 })
        });
        const beforeMessages = (
          (await (await t.fetch(`/v1/sessions/${sessionId}/messages`)).json()) as {
            messages: unknown[];
          }
        ).messages;
        expect(beforeMessages).toEqual([]);

        // Codex, a real managed agent bound into this session, adds a plan todo through the same
        // internal proxy a live CLI runtime uses (apps/monad/src/transports/http/native-agent.ts) —
        // not a direct store write.
        const addRes = await t.fetch('/v1/internal/native-agent/project/plan/todos', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...s5BindingHeaders(codexMesh) },
          body: JSON.stringify({ requestId: 'idem_s5planadd001', text: 'ship the release notes' })
        });
        expect(addRes.status).toBe(200);
        const addedTodo = ((await addRes.json()) as { todo: { id: string } }).todo;

        // No fan-out, no inbox delivery on either the legacy mesh-agent-inbox path or the managed
        // project-ingress path, and neither SessionBinding's delivery cursor or current runtime
        // pointer moved — the mutation is a pure control-plane fact, invisible to both runtimes.
        expect(deliverySnapshot()).toEqual(before);
        const afterMessages = (
          (await (await t.fetch(`/v1/sessions/${sessionId}/messages`)).json()) as {
            messages: unknown[];
          }
        ).messages;
        expect(afterMessages).toEqual([]);

        // Durable state landed exactly as mutated — the real row, not a mock handler's own echo.
        const todos = handlers.store.sessionPlans.listTodos(sessionId);
        expect(todos).toEqual([
          expect.objectContaining({ id: addedTodo.id, text: 'ship the release notes', status: 'pending' })
        ]);

        // The mutation is durably audited and attributed to codex's own canonical member — a second,
        // independent durable side effect distinct from the todo row and from the event system.
        const audit = handlers.store.sessionPlans.listAudit(sessionId);
        expect(audit).toEqual([
          expect.objectContaining({
            sessionId,
            requestId: 'idem_s5planadd001',
            operation: 'add',
            todoId: addedTodo.id,
            projectMemberId: codexId,
            outcome: 'applied'
          })
        ]);

        // The plan event was actually published, not left stranded in the outbox — the boot-drain
        // contract (session-plan-boot.ts) only republishes events still pending here.
        const stillPendingForSession = handlers.store.sessionPlans
          .listPendingEvents()
          .filter((event) => event.payload.sessionId === sessionId);
        expect(stillPendingForSession).toEqual([]);

        // Neither provider's model was ever invoked: SessionPlan mutations are session-scoped,
        // control-plane-only facts (event-table.ts) — they must never enter agent fan-out/wake.
        expect(spy).toEqual({ stream: 0, complete: 0 });
      } finally {
        await rm(sharedCwd, { recursive: true, force: true });
      }
    });
  });

  // The Daemon starts WITHOUT a configured model provider and stays operable — there is no global
  // init gate. A no-Web client completes the whole required Setup through Admin Methods alone.
  // Runs on a real temp ~/.monad so persistence is exercised, not stubbed.
  describe(`headless setup over ${kind}`, () => {
    let dir: string;
    let paths: MonadPaths;
    let t: TransportHandle;

    beforeEach(async () => {
      dir = join(tmpdir(), `monad-headless-setup-${Date.now()}-${process.hrtime.bigint()}`);
      paths = makeTestPaths(dir);
      await initMonadHome(paths);
      const cfg = await loadConfig(paths);
      if (!cfg) throw new Error('config missing after init');
      const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), { paths, modelService })));
    });

    afterEach(async () => {
      await t.stop();
      await rm(dir, { recursive: true, force: true });
    });

    const json = (method: string, path: string, body?: unknown) =>
      t.fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    const providerIds = async (): Promise<string[]> => {
      const res = (await (await json('GET', '/v1/settings/model/providers')).json()) as {
        providers: { id: string }[];
      };
      return res.providers.map((provider) => provider.id);
    };

    test('a fresh daemon serves settings before any provider exists, then a no-Web client configures it end to end', async () => {
      const beforeRes = await json('GET', '/v1/settings/model/providers');
      expect(beforeRes.status).toBe(200);
      const before = await providerIds();
      expect(before).not.toContain('oai');

      const providerRes = await json('PUT', '/v1/settings/model/providers/oai', {
        provider: {
          id: 'oai',
          label: 'OpenAI-compatible',
          type: 'openai-compatible',
          baseUrl: 'https://api.test/v1'
        }
      });
      expect(providerRes.status).toBe(200);

      const credRes = await json('POST', '/v1/settings/model/providers/oai/credentials', {
        label: 'primary',
        authType: 'api_key',
        accessToken: 'sk-headless-setup-9876'
      });
      const added = (await credRes.json()) as { id: string };
      expect(added.id).toMatch(/^cred_/);

      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: {
          alias: 'default',
          routes: { chat: { provider: 'oai', modelId: 'gpt-x' } },
          params: {},
          fallbacks: []
        }
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'default' });

      expect(await providerIds()).toEqual([...before, 'oai']);
      const profiles = (await (await json('GET', '/v1/settings/model/profiles')).json()) as {
        defaultAlias: string;
      };
      expect(profiles.defaultAlias).toBe('default');
    });

    test('the setup credential is redacted in responses but persisted in full to agents.json', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: {
          id: 'oai',
          label: 'OpenAI-compatible',
          type: 'openai-compatible',
          baseUrl: 'https://api.test/v1'
        }
      });
      await json('POST', '/v1/settings/model/providers/oai/credentials', {
        label: 'primary',
        authType: 'api_key',
        accessToken: 'sk-headless-setup-9876'
      });

      const listed = (await (await json('GET', '/v1/settings/model/providers/oai/credentials')).json()) as {
        credentials: Array<Record<string, unknown>>;
      };
      expect(listed.credentials).toHaveLength(1);
      const view = listed.credentials[0] ?? {};
      expect(view.configured).toBe(true);
      // presence-ok: redaction is the business contract — the raw token must not travel in the response
      expect(view).not.toHaveProperty('accessToken');
      expect(view).not.toHaveProperty('accessTokenPreview');

      const cfg = await loadConfig(paths);
      const auth = await loadAuth(paths.auth);
      expect(cfg?.model.providers.find((provider) => provider.id === 'oai')?.credentials[0]?.accessToken).toBe(
        'sk-headless-setup-9876'
      );
      expect(auth?.credentials).toEqual({});
    });
  });
}
