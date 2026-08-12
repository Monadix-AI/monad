import type { Database } from 'bun:sqlite';

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChatMessage,
  type Event,
  type MeshSessionId,
  type MessageId,
  nativeAgentRuntimeInfoResponseSchema,
  type ProjectId,
  parseEventPayload,
  type SessionId,
  type SessionUiEvent
} from '@monad/protocol';

import { createHttpTransport } from '#/transports/http.ts';
import { DAEMON_E2E_TIMEOUT_BUDGET } from '../../scripts/e2e-timeout-budget.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  serveTransport,
  stubModelDeps,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';
import { connectionGate } from '../wait.ts';

const AGENT_TOKEN = 'managed-agent-token';

const tokenHash = (token = AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

const json = (body: unknown, headers?: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

let projectPostRequestSequence = 0;
const projectPostJson = (body: Record<string, unknown>, headers?: Record<string, string>): RequestInit =>
  json({ requestId: `native-agent-e2e-${++projectPostRequestSequence}`, ...body }, headers);

let directSendRequestSequence = 0;
const directSendJson = (body: Record<string, unknown>, headers?: Record<string, string>): RequestInit =>
  json({ requestId: `native-agent-direct-e2e-${++directSendRequestSequence}`, ...body }, headers);

async function responseError(
  res: Response
): Promise<{ error?: string; code?: string; requestId?: string; retryable?: boolean }> {
  return (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    requestId?: string;
    retryable?: boolean;
  };
}

async function createProject(t: TransportHandle): Promise<ProjectId> {
  const res = await t.fetch('/v1/workplace/projects', json({ title: 'Workplace: managed native agent' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { projectId: ProjectId }).projectId;
}

// A project (prj_) is an environment; its conversation is a real session (ses_) created under it.
// Every transcript/binding id in this file is the session id, never the project id.
async function createProjectSession(t: TransportHandle, projectId: ProjectId, cwd?: string): Promise<SessionId> {
  const res = await t.fetch(
    `/v1/projects/${projectId}/sessions`,
    json({ title: 'Workplace: managed native agent', ...(cwd ? { cwd } : {}) })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

// Convenience: create a project and its single conversation session in one step.
async function createSession(t: TransportHandle, cwd?: string): Promise<SessionId> {
  const projectId = await createProject(t);
  return createProjectSession(t, projectId, cwd);
}

async function messages(t: TransportHandle, sessionId: SessionId): Promise<Array<{ role: string; text: string }>> {
  const res = await t.fetch(`/v1/sessions/${sessionId}/messages`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: Array<{ role: string; text: string }> }).messages.map(({ role, text }) => ({
    role,
    text
  }));
}

async function rawMessages(t: TransportHandle, sessionId: SessionId): Promise<ChatMessage[]> {
  const res = await t.fetch(`/v1/sessions/${sessionId}/messages`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: ChatMessage[] }).messages;
}

// A "project message" fan-out now targets a SESSION id via the channel alias
// (POST /v1/channels/:sessionId/messages → sendChannelMessage → sendProjectMessage).
async function _sendChannelMessage(t: TransportHandle, sessionId: SessionId, text: string): Promise<Response> {
  return t.fetch(`/v1/channels/${sessionId}/messages`, json({ text }));
}

// Live per-session member binding (Track B `session_members`), inserted directly so display-name
// resolution and managed-member enumeration see the member without spawning a real runtime.
function addSessionMember(
  handlers: ReturnType<typeof buildHandlers>,
  sessionId: SessionId,
  agentName: string,
  displayName: string
): void {
  const now = new Date().toISOString();
  handlers.store.insertSessionMember({
    sessionId,
    memberId: agentName,
    templateId: null,
    type: 'mesh-agent',
    data: { name: agentName, displayName, settings: { managedProjectAgent: true } },
    createdAt: now,
    updatedAt: now
  });
}

// Adds a canonical roster member (ProjectMember + active SessionBinding) with no running runtime, so the
// canonical roster lists it as offline. The roster reads bindings/ProjectMembers, never legacy rows.
function addBoundMember(
  handlers: ReturnType<typeof buildHandlers>,
  sessionId: SessionId,
  memberId: string,
  displayName: string
): void {
  const projectId = handlers.store.getSession(sessionId)?.projectId;
  if (!projectId) throw new Error(`session has no project: ${sessionId}`);
  const now = new Date().toISOString();
  handlers.store.insertProjectMember({
    id: memberId,
    projectId,
    profileId: memberId,
    type: 'mesh-agent',
    displayName,
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: now,
    updatedAt: now
  });
  handlers.store.insertSessionBinding({
    sessionId,
    projectMemberId: memberId,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now
  });
}

function bindingHeaders(
  _sessionId: SessionId,
  meshSessionId = 'mesh_test00000000',
  _agentId = 'codex'
): Record<string, string> {
  return {
    authorization: `Bearer ${AGENT_TOKEN}`,
    'x-monad-mesh-session-id': meshSessionId
  };
}

function createManagedNativeSession(
  handlers: ReturnType<typeof buildHandlers>,
  sessionId: SessionId,
  id = 'mesh_test00000000',
  agentName = 'codex',
  state: 'running' | 'stopped' = 'running',
  workingPath = '/tmp/project',
  outputSnapshot = ''
): void {
  handlers.store.upsertMeshSession({
    id,
    transcriptTargetId: sessionId,
    agentName,
    provider: agentName === 'claude' ? 'claude-code' : 'codex',
    workingPath,
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: id,
    agentRuntimeTokenHash: tokenHash(),
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state,
    pid: state === 'running' ? 123 : null,
    providerSessionRef: null,
    outputSnapshot,
    exitCode: null,
    startedAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    exitedAt: state === 'running' ? null : '2026-06-30T00:00:01.000Z'
  });
  // S2-a: a managed runtime is owned by a ProjectMember and is the current runtime of that member's
  // SessionBinding. The real spawn path establishes this via replaceSessionBindingRuntime; mirror it here
  // so the delivery cursor fence resolves ownership strictly from the runtime row.
  const projectId = handlers.store.getSession(sessionId)?.projectId;
  if (projectId) {
    const memberId = `pmem_${agentName}`;
    const at = '2026-06-30T00:00:00.000Z';
    if (!handlers.store.getProjectMember(projectId, memberId)) {
      handlers.store.insertProjectMember({
        id: memberId,
        projectId,
        profileId: agentName,
        type: 'mesh-agent',
        displayName: agentName,
        customPrompt: null,
        launchOverrides: {},
        workingDirectoryOverride: null,
        lifecycle: 'enabled',
        createdAt: at,
        updatedAt: at
      });
    }
    if (!handlers.store.getSessionBinding(sessionId, memberId)) {
      handlers.store.insertSessionBinding({
        sessionId,
        projectMemberId: memberId,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        lifecycle: 'active',
        createdAt: at,
        updatedAt: at
      });
    }
    handlers.store.replaceSessionBindingRuntime({
      sessionId,
      projectMemberId: memberId,
      currentNativeRuntimeSessionId: id as MeshSessionId,
      updatedAt: at
    });
  }
}

for (const kind of TRANSPORTS) {
  describe(`native agent runtime bridge over ${kind}`, () => {
    let t: TransportHandle;

    afterEach(async () => {
      await t?.stop();
    });

    test('project post keeps inbox delivery triggers unrelated unless replyToMessageId is explicit', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      handlers.store.insertMessage(
        'msg_TRIGGER00000',
        sessionId,
        'incoming request',
        '2026-06-30T00:00:01.000Z',
        'user'
      );
      handlers.store.enqueueMeshAgentInboxItem('mesh_test00000000', 1, {
        deliveryId: 'deliv_TRIGGER0000',
        triggerMessageId: 'msg_TRIGGER00000'
      });
      handlers.store.markMeshAgentInboxDelivered('mesh_test00000000', 1);
      const turnEvents: Event[] = [];
      const disposeEvents = handlers.bus.subscribe(sessionId, (event) => {
        if (event.type === 'mesh.turn_settled') turnEvents.push(event);
      });

      const unrelated = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'unrelated update' }, bindingHeaders(sessionId))
      );
      const explicit = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'managed reply', replyToMessageId: 'msg_TRIGGER00000' },
          bindingHeaders(sessionId)
        )
      );
      disposeEvents();

      expect(unrelated.status).toBe(200);
      expect(explicit.status).toBe(200);
      expect(handlers.store.listMessages(sessionId).map((message) => message.replyToMessageId)).toEqual([
        undefined,
        undefined,
        'msg_TRIGGER00000'
      ]);
      const unrelatedPost = ((await unrelated.json()) as { message: { replyToMessageId?: string } }).message;
      const explicitReply = ((await explicit.json()) as { message: { replyToMessageId?: string } }).message;
      expect(unrelatedPost.replyToMessageId).toBeUndefined();
      expect(explicitReply.replyToMessageId).toBe('msg_TRIGGER00000');
      expect(await messages(t, sessionId)).toEqual([
        { role: 'user', text: 'incoming request' },
        { role: 'assistant', text: 'unrelated update' },
        { role: 'assistant', text: 'managed reply' }
      ]);
      // presence-ok: a room post must not claim that the provider turn has ended.
      expect(turnEvents).toEqual([]);
    });

    test('explicit project replies replace pending Thinking placeholders with canonical reply edges', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      handlers.store.insertMessage(
        'msg_REPLYTARGET0',
        sessionId,
        'Please confirm the rollout.',
        '2026-06-30T00:00:01.000Z',
        'user'
      );
      handlers.store.insertMessage('msg_THINKING0000', sessionId, '', '2026-06-30T00:00:02.000Z', 'assistant', {
        data: {
          memberId: 'pmem_codex',
          meshSessionId: 'mesh_test00000000',
          reasoning: 'Thinking',
          source: 'managed-mesh-agent'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      const lifecycle: Event[] = [];
      const disposeEvents = handlers.bus.subscribe(sessionId, (event) => {
        if (event.type === 'session.message.deleted' || event.type === 'session.message.created') lifecycle.push(event);
      });

      const response = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'Rollout confirmed.', replyToMessageId: 'msg_REPLYTARGET0' },
          bindingHeaders(sessionId)
        )
      );
      disposeEvents();

      expect(response.status).toBe(200);
      const posted = (await response.json()) as { message: { id: string; replyToMessageId?: string } };
      const finalMessage = handlers.store.getMessage(sessionId, posted.message.id);
      expect(posted.message.id).not.toBe('msg_THINKING0000');
      expect(finalMessage).toMatchObject({
        text: 'Rollout confirmed.',
        replyToMessageId: 'msg_REPLYTARGET0',
        stream: { status: 'settled' },
        active: true
      });
      expect(handlers.store.getMessage(sessionId, 'msg_THINKING0000')?.active).toBe(false);
      expect(lifecycle.map((event) => event.type)).toEqual(['session.message.deleted', 'session.message.created']);
      expect(await rawMessages(t, sessionId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: posted.message.id, replyToMessageId: 'msg_REPLYTARGET0' })
        ])
      );
    });

    test('session members reports current-session delivery availability', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t, process.cwd());
      // Canonical roster from SessionBindings: `missing-reviewer` is bound but has no running runtime
      // (offline); `pmem_builder` owns a live managed runtime (online); the requester `pmem_codex` (its own
      // runtime) excludes itself.
      addBoundMember(handlers, sessionId, 'missing-reviewer', 'Reviewer');
      createManagedNativeSession(handlers, sessionId);
      createManagedNativeSession(handlers, sessionId, 'mesh_peer00000000', 'builder');

      const res = await t.fetch('/v1/internal/native-agent/session/members', {
        headers: bindingHeaders(sessionId)
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        members: [
          { id: 'missing-reviewer', displayName: 'Reviewer', status: 'offline' },
          { id: 'pmem_builder', displayName: 'builder', status: 'online' }
        ]
      });
    });

    test('managed identity: project and direct attribution are both the canonical projectMemberId', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-idsplit-')));
      // The runtime's agentName ('codex') is only its provider alias; its owning ProjectMember is
      // 'pmem_codex'. Both project AND direct attribution now record the canonical id, never the alias.
      addSessionMember(handlers, sessionId, 'pmem_codex', 'Lily');
      createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', 'codex', 'running', dir);
      try {
        const projectFile = join(dir, 'project.md');
        await writeFile(projectFile, 'project attachment body', 'utf8');
        const posted = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson({ sessionId, attachments: [{ path: projectFile }] }, bindingHeaders(sessionId))
        );
        expect(posted.status).toBe(200);
        const projectAttId = ((await posted.json()) as { message: { attachments?: Array<{ id: string }> } }).message
          .attachments?.[0]?.id;
        if (!projectAttId) throw new Error('expected a project attachment ref');
        // Project attachment attribution is the canonical projectMemberId, not the legacy delivery key.
        expect(handlers.store.getMessageAttachment(projectAttId)?.createdBy).toBe('pmem_codex');

        const directFile = join(dir, 'direct.md');
        await writeFile(directFile, 'direct attachment body', 'utf8');
        const sent = await t.fetch(
          '/v1/internal/native-agent/agent/send',
          directSendJson({ to: 'human:zeke', attachments: [{ path: directFile }] }, bindingHeaders(sessionId))
        );
        expect(sent.status).toBe(200);
        const sentMessage = (
          (await sent.json()) as { message: { fromAgent: string; attachments?: Array<{ id: string }> } }
        ).message;
        // Direct message sender + attachment attribution are the canonical projectMemberId, not the alias.
        expect(sentMessage.fromAgent).toBe('pmem_codex');
        const directAttId = sentMessage.attachments?.[0]?.id;
        if (!directAttId) throw new Error('expected a direct attachment ref');
        expect(handlers.store.getMessageAttachment(directAttId)?.createdBy).toBe('pmem_codex');

        // Runtime-info exposes only the canonical identity; the legacy key never reaches the wire.
        const info = nativeAgentRuntimeInfoResponseSchema.parse(
          await (await t.fetch('/v1/internal/native-agent/runtime/info', { headers: bindingHeaders(sessionId) })).json()
        );
        expect(info.projectMemberId).toBe('pmem_codex');
        // presence-ok: the removed legacy field must never reappear on the runtime-info wire shape
        expect('agentId' in info).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('file attachment post: reference registered, wall stores marker-free preview, web reads the file', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      // realpath: attachment refs are canonicalized, and registration confines paths to the
      // runtime's working directory — the session's workingPath must be the (real) test dir.
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', 'codex', 'running', dir);
      try {
        const longBody = `START ${'x'.repeat(150_000)} END`;
        const filePath = join(dir, 'report.md');
        const extraPath = join(dir, 'notes.txt');
        await writeFile(filePath, longBody, 'utf8');
        await writeFile(extraPath, 'side notes', 'utf8');

        const posted = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson(
            { sessionId, attachments: [{ path: filePath }, { path: extraPath }] },
            bindingHeaders(sessionId)
          )
        );
        expect(posted.status).toBe(200);
        const postedBody = (await posted.json()) as {
          message: { text: string; attachments?: Array<{ id: string; path: string; name: string; bytes: number }> };
        };
        const attachments = postedBody.message.attachments ?? [];
        expect(attachments).toHaveLength(2);
        const attachment = attachments[0];
        if (!attachment) throw new Error('expected attachment ref on posted message');
        expect(attachment.id.startsWith('att_')).toBe(true);
        expect(attachment.path).toBe(filePath);
        expect(attachment.name).toBe('report.md');
        expect(attachment.bytes).toBe(Buffer.byteLength(longBody, 'utf8'));
        expect(attachments[1]?.name).toBe('notes.txt');

        // Wall stores only the bounded, marker-free preview; the structured refs live in message
        // data (rendered as chips) and reference markers appear only in stdin notices.
        const wall = await messages(t, sessionId);
        expect(wall).toHaveLength(1);
        const wallText = wall[0]?.text ?? '';
        expect(wallText.startsWith('START ')).toBe(true);
        expect(wallText).not.toContain('[Attachment');
        expect(wallText.length).toBeLessThan(3_000);

        // Client-facing read (web wall): bounded JSON preview and raw download from the file.
        const webRes = await t.fetch(`/v1/file-preview?attachmentId=${attachment.id}`);
        expect(webRes.status).toBe(200);
        const webBody = (await webRes.json()) as { text: string; truncated?: boolean };
        expect(webBody.text.startsWith('START ')).toBe(true);
        const download = await t.fetch(`/v1/file-preview?attachmentId=${attachment.id}&download=1`);
        expect(download.status).toBe(200);
        expect(download.headers.get('content-disposition')).toContain('report.md');
        expect(await download.text()).toBe(longBody);

        // Reference semantics: deleting the file makes later reads report the reference as gone.
        await rm(filePath);
        expect((await t.fetch(`/v1/file-preview?attachmentId=${attachment.id}`)).status).toBe(410);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('non-Latin-1 attachment names download with an RFC 5987 content-disposition', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', 'codex', 'running', dir);
      try {
        const filePath = join(dir, '项目报告.md');
        await writeFile(filePath, '# 报告', 'utf8');
        const posted = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson({ sessionId, attachments: [{ path: filePath }] }, bindingHeaders(sessionId))
        );
        expect(posted.status).toBe(200);
        const { message } = (await posted.json()) as { message: { attachments?: Array<{ id: string }> } };
        const id = message.attachments?.[0]?.id;
        if (!id) throw new Error('expected attachment ref');
        const download = await t.fetch(`/v1/file-preview?attachmentId=${id}&download=1`);
        expect(download.status).toBe(200);
        expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''");
        expect(await download.text()).toBe('# 报告');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('PDF attachments stream inline for the web preview without widening inline access', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-pdf-attachment-')));
      createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', 'codex', 'running', dir);
      try {
        const pdfBody = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF';
        const pdfPath = join(dir, 'evidence.pdf');
        const textPath = join(dir, 'notes.txt');
        await writeFile(pdfPath, pdfBody);
        await writeFile(textPath, 'notes');
        const posted = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson(
            {
              sessionId,
              attachments: [
                { path: pdfPath, mime: 'application/pdf' },
                { path: textPath, mime: 'text/plain' }
              ]
            },
            bindingHeaders(sessionId)
          )
        );
        expect(posted.status).toBe(200);
        const body = (await posted.json()) as { message: { attachments?: Array<{ id: string }> } };
        const [pdfAttachment, textAttachment] = body.message.attachments ?? [];
        if (!pdfAttachment || !textAttachment) throw new Error('expected PDF and text attachment refs');

        const inline = await t.fetch(`/v1/file-preview?attachmentId=${pdfAttachment.id}&inline=1`);
        expect({
          body: await inline.text(),
          cacheControl: inline.headers.get('cache-control'),
          contentDisposition: inline.headers.get('content-disposition'),
          contentType: inline.headers.get('content-type'),
          nosniff: inline.headers.get('x-content-type-options'),
          status: inline.status
        }).toEqual({
          body: pdfBody,
          cacheControl: 'private, no-store',
          contentDisposition: expect.stringContaining('inline; filename="evidence.pdf"'),
          contentType: 'application/pdf',
          nosniff: 'nosniff',
          status: 200
        });
        expect((await t.fetch(`/v1/file-preview?attachmentId=${textAttachment.id}&inline=1`)).status).toBe(400);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('attachment endpoint serves registered references from outside the agent workspace', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      const outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'monad-outside-')));
      createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', 'codex', 'running', dir);
      try {
        // The web endpoint is id-gated: unregistered ids never resolve to file reads.
        expect((await t.fetch('/v1/file-preview?attachmentId=att_100000000000')).status).toBe(404);

        // Referencing a nonexistent file fails the post outright; nothing lands on the wall.
        const missing = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson({ sessionId, attachments: [{ path: join(dir, 'nope.md') }] }, bindingHeaders(sessionId))
        );
        expect(missing.status).toBe(400);

        const secretPath = join(outsideDir, 'secret.txt');
        await writeFile(secretPath, 'not yours', 'utf8');
        const outside = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson({ sessionId, attachments: [{ path: secretPath }] }, bindingHeaders(sessionId))
        );
        expect(outside.status).toBe(200);
        const { message } = (await outside.json()) as { message: { attachments?: Array<{ id: string }> } };
        const id = message.attachments?.[0]?.id;
        if (!id) throw new Error('expected attachment ref');
        const attachment = await t.fetch(`/v1/file-preview?attachmentId=${id}`);
        expect(attachment.status).toBe(200);
        expect(await attachment.json()).toEqual({
          resource: {
            path: secretPath,
            name: 'secret.txt',
            mime: 'text/plain',
            bytes: 9
          },
          text: 'not yours',
          truncated: false
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    test('managed project agents can attach files from their Monad-managed workspace', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'monad-native-agent-managed-'));
      const modelDeps = { ...stubModelDeps(), paths: makeTestPaths(dir) };
      const handlers = buildHandlers(mockModel(), modelDeps);
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const projectDir = await realpath(await mkdtemp(join(tmpdir(), 'monad-project-')));
      const agentName = 'pmem_claude-code_123';
      const managedWorkspace = join(dir, 'workplace', sessionId, agentName);
      await mkdir(managedWorkspace, { recursive: true });
      createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', agentName, 'running', projectDir);
      try {
        const filePath = join(managedWorkspace, 'proposal.md');
        await writeFile(filePath, '# Proposal', 'utf8');
        const posted = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson({ attachments: [{ path: filePath, mime: 'text/markdown' }] }, bindingHeaders(sessionId))
        );

        expect(posted.status).toBe(200);
        const { message } = (await posted.json()) as { message: { attachments?: Array<{ id: string }> } };
        const id = message.attachments?.[0]?.id;
        if (!id) throw new Error('expected attachment ref');
        const read = await t.fetch(`/v1/file-preview?attachmentId=${id}`);
        const readBody = await read.text();
        expect({ status: read.status, body: readBody }).toMatchObject({ status: 200 });
        expect((JSON.parse(readBody) as { text: string }).text).toBe('# Proposal');
      } finally {
        await rm(projectDir, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('agent send with a file attachment keeps the direct ledger bounded to preview + reference', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', 'codex', 'running', dir);
      try {
        const longBody = `PRIVATE ${'y'.repeat(140_000)}`;
        const filePath = join(dir, 'private-note.txt');
        await writeFile(filePath, longBody, 'utf8');

        const sent = await t.fetch(
          '/v1/internal/native-agent/agent/send',
          directSendJson({ to: 'human:zeke', attachments: [{ path: filePath }] }, bindingHeaders(sessionId))
        );
        expect(sent.status).toBe(200);

        const read = await t.fetch(
          '/v1/internal/native-agent/agent/read',
          json({ with: 'human:zeke' }, bindingHeaders(sessionId))
        );
        const { messages: direct } = (await read.json()) as {
          messages: Array<{ text: string; attachments?: Array<{ id: string; path: string }> }>;
        };
        expect(direct).toHaveLength(1);
        expect(direct[0]?.attachments?.[0]?.path).toBe(filePath);
        expect(direct[0]?.text.startsWith('PRIVATE ')).toBe(true);
        expect(direct[0]?.text).not.toContain('[Attachment');
        expect(direct[0]?.text.length ?? 0).toBeLessThan(3_000);
        expect(await messages(t, sessionId)).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('project ask renders a structured question and returns the user answer to the managed runtime', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      // The managed runtimes are owned by pmem_codex / pmem_claude (createManagedNativeSession stamps
      // project_member_id = pmem_<agent>); the roster members must carry those canonical ids.
      addSessionMember(handlers, sessionId, 'pmem_codex', 'Lily');
      addSessionMember(handlers, sessionId, 'pmem_claude', 'Steve');
      createManagedNativeSession(handlers, sessionId);
      createManagedNativeSession(handlers, sessionId, 'mesh_peer00000000', 'claude');
      const askGate = connectionGate();
      const requested = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'clarify.requested',
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.streamMs,
        onConnected: askGate.onConnected
      });
      await askGate.ready;

      const ask = t.fetch(
        '/v1/internal/native-agent/project/ask',
        json(
          {
            question: 'Which path should I take?',
            options: ['Ship', 'Revise'],
            mode: 'multiple',
            allowOther: true
          },
          bindingHeaders(sessionId)
        )
      );

      const requestEvent = ((await requested) as Event[]).find((event) => event.type === 'clarify.requested');
      expect(requestEvent?.payload).toMatchObject({
        question: 'Which path should I take?',
        options: ['Ship', 'Revise'],
        mode: 'multiple',
        allowOther: true,
        asker: { id: 'pmem_codex', name: 'Lily' }
      });
      const requestId = requestEvent?.payload.requestId as string;
      const projectId = handlers.store.getSession(sessionId)?.projectId;
      if (!projectId) throw new Error('missing project id');
      expect(handlers.store.getNativeAgentMemberGate(sessionId, 'pmem_codex')).toMatchObject({
        requestId,
        state: 'waiting_sync'
      });
      const peerPost = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'Peer replied while the question was open' },
          bindingHeaders(sessionId, 'mesh_peer00000000', 'claude')
        )
      );
      expect(peerPost.status).toBe(200);
      const answer = await t.fetch('/v1/clarifications/respond', json({ requestId, answer: '["Ship"]' }));
      expect(answer.status).toBe(200);

      const res = await ask;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        requestId,
        status: 'answered',
        answer: '["Ship"]',
        answers: { q1: ['Ship'] }
      });
      expect(handlers.store.getNativeAgentAsk(requestId)).toMatchObject({
        state: 'recovered',
        outcome: 'answered',
        answers: { q1: ['Ship'] }
      });
      const wall = await messages(t, sessionId);
      expect(wall).toEqual([
        { role: 'assistant', text: 'Q: Which path should I take?\nOptions: Ship | Revise' },
        { role: 'assistant', text: 'Peer replied while the question was open' },
        { role: 'user', text: 'Ship' }
      ]);
      const canonicalMessages = await rawMessages(t, sessionId);
      const questionMessage = canonicalMessages.find(
        (message) => message.id === requestEvent?.payload.questionMessageId
      );
      expect(questionMessage?.data).toEqual({
        agentName: 'Lily',
        kind: 'project-qa',
        options: ['Ship', 'Revise'],
        question: 'Which path should I take?'
      });
      expect(canonicalMessages.find((message) => message.role === 'user')).toMatchObject({
        text: 'Ship',
        replyToMessageId: questionMessage?.id
      });
      const summaryMessage = (await rawMessages(t, sessionId)).find((message) => message.role === 'system');
      // presence-ok: answering a managed project ask does not create a duplicate system summary
      expect(summaryMessage).toBeUndefined();

      const peerInbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_peer00000000', 'claude'))
      );
      expect(peerInbox.status).toBe(200);
      expect(
        ((await peerInbox.json()) as { items: Array<{ message: { role: string; text: string } }> }).items.map(
          (item) => ({ role: item.message.role, text: item.message.text })
        )
      ).toEqual([{ role: 'user', text: 'Ship' }]);
    });

    test('blocking project ask returns immediately while one multi-question card keeps the member gated', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const projectId = await createProject(t);
      const sessionId = await createProjectSession(t, projectId);
      addSessionMember(handlers, sessionId, 'pmem_codex', 'Lily');
      createManagedNativeSession(handlers, sessionId);
      const askGate = connectionGate();
      const requested = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'clarify.requested',
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.streamMs,
        onConnected: askGate.onConnected
      });
      await askGate.ready;

      const response = await t.fetch(
        '/v1/internal/native-agent/project/ask',
        json(
          {
            blocking: true,
            questions: [
              { question: 'Ship?', options: ['Yes', 'No'] },
              { id: 'why', question: 'Why?' }
            ]
          },
          bindingHeaders(sessionId)
        )
      );
      const requestEvent = ((await requested) as Event[]).find((event) => event.type === 'clarify.requested');
      const requestId = requestEvent?.payload.requestId as string;

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        requestId,
        status: 'awaiting_human',
        instruction: 'end_turn'
      });
      expect(requestEvent?.payload).toMatchObject({
        blocking: true,
        questions: [
          { id: 'q1', question: 'Ship?' },
          { id: 'why', question: 'Why?' }
        ]
      });
      expect(handlers.store.getNativeAgentMemberGate(sessionId, 'pmem_codex')).toMatchObject({
        requestId,
        state: 'awaiting_human'
      });

      const duplicate = await t.fetch(
        '/v1/internal/native-agent/project/ask',
        json({ question: 'Another question?' }, bindingHeaders(sessionId))
      );
      expect(duplicate.status).toBe(409);

      const answer = await t.fetch(
        '/v1/clarifications/respond',
        json({ requestId, answer: JSON.stringify({ q1: 'Yes', why: 'Ready' }) })
      );
      expect(answer.status).toBe(200);
      await Promise.resolve();
      expect(handlers.store.getNativeAgentAsk(requestId)).toMatchObject({
        state: 'recovered',
        outcome: 'answered',
        answers: { q1: 'Yes', why: 'Ready' }
      });
    });

    test('multiple managed replies reach the wall in post order and hydrate identically for a late viewer', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
      createManagedNativeSession(handlers, sessionId, 'mesh_claude000000', 'claude');

      // Two agents post to the wall in sequence.
      const first = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'codex: looks good' },
          bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
        )
      );
      expect(first.status).toBe(200);
      const second = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'claude: I agree' },
          bindingHeaders(sessionId, 'mesh_claude000000', 'claude')
        )
      );
      expect(second.status).toBe(200);

      // Raw transcript: both on the wall, in the order they were posted, with exact content.
      expect(await messages(t, sessionId)).toEqual([
        { role: 'assistant', text: 'codex: looks good' },
        { role: 'assistant', text: 'claude: I agree' }
      ]);

      // A viewer opening the session afterwards sees the same order + content in the projected UI.
      const events = await t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
        until: (e) => (e as unknown as SessionUiEvent).kind === 'snapshot',
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.streamMs
      });
      const snap = (events as unknown as SessionUiEvent[]).find((e) => e.kind === 'snapshot');
      if (snap?.kind !== 'snapshot') throw new Error('expected ui-stream snapshot');
      const wall = snap.items
        .filter((i) => i.kind === 'message')
        .map((i) => (i.kind === 'message' ? i.parts.find((p) => p.type === 'text') : undefined))
        .map((p) => (p?.type === 'text' ? p.text : undefined));
      expect(wall).toEqual(['codex: looks good', 'claude: I agree']);
    });

    test('replies posted out of fan-out order settle in completion order', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
      createManagedNativeSession(handlers, sessionId, 'mesh_claude000000', 'claude');

      // A human message fans out to both agents; each reserves a "thinking" placeholder at fan-out
      // time — codex a hair before claude (loop order), stamped in the far past to stand apart from
      // the (real-clock) completion time below.
      handlers.store.insertMessage('msg_USER00000000', sessionId, 'plan the split', '2020-01-01T00:00:01.000Z', 'user');
      handlers.store.insertMessage('msg_CODEX0000000', sessionId, '', '2020-01-01T00:00:02.000Z', 'assistant', {
        data: {
          memberId: 'pmem_codex',
          meshSessionId: 'mesh_codex0000000',
          reasoning: 'Thinking',
          source: 'managed-mesh-agent'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      handlers.store.insertMessage('msg_CLAUDE000000', sessionId, '', '2020-01-01T00:00:03.000Z', 'assistant', {
        data: {
          memberId: 'pmem_claude',
          meshSessionId: 'mesh_claude000000',
          reasoning: 'Thinking',
          source: 'managed-mesh-agent'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });

      // claude posts FIRST, codex SECOND — the reverse of the fan-out (placeholder) order.
      const claudePost = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'claude: here is the split' },
          bindingHeaders(sessionId, 'mesh_claude000000', 'claude')
        )
      );
      expect(claudePost.status).toBe(200);
      const codexPost = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'codex: that split matches mine' },
          bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
        )
      );
      expect(codexPost.status).toBe(200);

      // Completed replies are re-stamped when their placeholders settle, so a late viewer sees the
      // same completion order as the live project wall.
      const events = await t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
        until: (e) => (e as unknown as SessionUiEvent).kind === 'snapshot',
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.streamMs
      });
      const snap = (events as unknown as SessionUiEvent[]).find((e) => e.kind === 'snapshot');
      if (snap?.kind !== 'snapshot') throw new Error('expected ui-stream snapshot');
      const wall = snap.items
        .filter((i) => i.kind === 'message')
        .slice()
        .sort((a, b) => (a.kind === 'message' && b.kind === 'message' ? a.seq.localeCompare(b.seq) : 0))
        .map((i) => (i.kind === 'message' ? i.parts.find((p) => p.type === 'text') : undefined))
        .map((p) => (p?.type === 'text' ? p.text : undefined));
      expect(wall).toEqual(['plan the split', 'claude: here is the split', 'codex: that split matches mine']);
    });

    test('project post is streamed live even without a pending wake placeholder', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      let eventReady!: () => void;
      let uiReady!: () => void;
      const eventConnected = new Promise<void>((resolve) => {
        eventReady = resolve;
      });
      const uiConnected = new Promise<void>((resolve) => {
        uiReady = resolve;
      });
      const eventP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => {
          if (event.type !== 'session.message.created') return false;
          const message = parseEventPayload('session.message.created', event.payload).message;
          return (
            message.text === 'live managed reply' &&
            typeof message.data === 'object' &&
            message.data !== null &&
            'agentName' in message.data &&
            message.data.agentName === 'pmem_codex'
          );
        },
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.streamMs,
        onConnected: eventReady
      });
      const uiP = t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
        until: (event) => {
          const uiEvent = event as unknown as SessionUiEvent;
          return (
            uiEvent.kind === 'upsert' &&
            uiEvent.item.kind === 'message' &&
            uiEvent.item.role === 'assistant' &&
            uiEvent.item.agentName === 'pmem_codex' &&
            uiEvent.item.parts.some((part) => part.type === 'text' && part.text === 'live managed reply')
          );
        },
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.streamMs,
        onConnected: uiReady
      });
      await Promise.all([eventConnected, uiConnected]);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'live managed reply' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(200);
      const streamedEvent = (await eventP).at(-1);
      expect(streamedEvent?.type).toBe('session.message.created');
      const streamedUiEvent = (await uiP).at(-1) as SessionUiEvent | undefined;
      expect(streamedUiEvent?.kind).toBe('upsert');
      expect(await messages(t, sessionId)).toEqual([{ role: 'assistant', text: 'live managed reply' }]);
    });

    test('duplicate project posts from the same runtime land as separate messages', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const first = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'KTzhou joined. Ready for tasks.' }, bindingHeaders(sessionId))
      );
      const second = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'KTzhou joined. Ready for tasks.' }, bindingHeaders(sessionId))
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await messages(t, sessionId)).toEqual([
        { role: 'assistant', text: 'KTzhou joined. Ready for tasks.' },
        { role: 'assistant', text: 'KTzhou joined. Ready for tasks.' }
      ]);
    });

    test('project post replays one durable mutation without repeating attachments, cursors, or notifications', async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-project-post-replay-')));
      const filePath = join(dir, 'report.md');
      await writeFile(filePath, 'durable report', 'utf8');
      try {
        const handlers = buildHandlers(mockModel());
        const deletedAttachments = spyOn(handlers.store, 'deleteMessageAttachments');
        const notifications = spyOn(handlers.session, 'notifyManagedMeshAgentProjectMembers');
        t = serveTransport(kind, createHttpTransport(handlers));
        const sessionId = await createSession(t, dir);
        createManagedNativeSession(handlers, sessionId, 'mesh_test00000000', 'codex', 'running', dir);
        const body = {
          requestId: 'durable-project-post',
          sessionId,
          text: 'durable update',
          attachments: [{ path: filePath }]
        };

        const first = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson(body, bindingHeaders(sessionId))
        );
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as {
          message: { id: string; text: string; attachments?: Array<{ id: string }> };
        };
        const originalAttachmentId = firstBody.message.attachments?.[0]?.id;
        if (!originalAttachmentId) throw new Error('expected original attachment');
        handlers.store.insertMessage(
          'msg_PENDING00000',
          sessionId,
          'pending inbox item',
          '2026-07-24T00:00:00.000Z',
          'user'
        );
        const pendingSeq = handlers.store.maxMessageSeq(sessionId);
        handlers.store.enqueueMeshAgentInboxItem('mesh_test00000000', pendingSeq);
        handlers.store.markMeshAgentInboxDelivered('mesh_test00000000', pendingSeq);
        const visibleBeforeReplay = handlers.store.getMeshSession('mesh_test00000000')?.lastVisibleSeq;

        const replay = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson(body, bindingHeaders(sessionId))
        );
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(firstBody);
        expect(await messages(t, sessionId)).toEqual([
          { role: 'assistant', text: 'durable update' },
          { role: 'user', text: 'pending inbox item' }
        ]);
        expect(handlers.store.getMeshSession('mesh_test00000000')?.lastVisibleSeq).toBe(visibleBeforeReplay);
        expect(handlers.store.listMeshAgentInbox('mesh_test00000000')).toMatchObject([
          { deliveryState: 'delivered', message: { id: 'msg_PENDING00000', text: 'pending inbox item' } }
        ]);
        expect(notifications).toHaveBeenCalledTimes(1);
        expect(deletedAttachments).toHaveBeenCalledTimes(1);
        expect(deletedAttachments.mock.calls[0]?.[0]).toEqual([
          expect.not.stringMatching(new RegExp(`^${originalAttachmentId}$`))
        ]);

        const conflict = await t.fetch(
          '/v1/internal/native-agent/project/post',
          projectPostJson({ ...body, text: 'different update' }, bindingHeaders(sessionId))
        );
        expect(conflict.status).toBe(409);
        expect(await responseError(conflict)).toEqual({
          error: 'idempotency key reused with a different command',
          code: 'IDEMPOTENCY_CONFLICT',
          requestId: expect.stringMatching(/^req_/),
          retryable: false
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('project post replays after replacing a thinking placeholder and recreating handlers', async () => {
      const handlers = buildHandlers(mockModel());
      const firstNotify = spyOn(handlers.session, 'notifyManagedMeshAgentProjectMembers');
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      handlers.store.insertMessage('msg_THINKING0000', sessionId, '', '2026-07-24T00:00:00.000Z', 'assistant', {
        data: {
          agentName: 'codex',
          meshSessionId: 'mesh_test00000000',
          reasoning: 'Thinking',
          source: 'managed-mesh-agent'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      const request = { requestId: 'project-post-after-thinking', sessionId, text: 'durable final answer' };

      const firstResponse = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(request, bindingHeaders(sessionId))
      );
      expect(firstResponse.status).toBe(200);
      const first = (await firstResponse.json()) as { message: { id: MessageId; text: string; createdAt: string } };

      await t.stop();
      const recreated = buildHandlers(mockModel(), stubModelDeps(), { store: handlers.store });
      createManagedNativeSession(recreated, sessionId);
      const replayNotify = spyOn(recreated.session, 'notifyManagedMeshAgentProjectMembers');
      t = serveTransport(kind, createHttpTransport(recreated));
      const replayResponse = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(request, bindingHeaders(sessionId))
      );
      const conflictResponse = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ ...request, replyToMessageId: first.message.id }, bindingHeaders(sessionId))
      );

      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.json()).toEqual(first);
      expect(await messages(t, sessionId)).toEqual([{ role: 'assistant', text: 'durable final answer' }]);
      expect({
        firstNotifications: firstNotify.mock.calls.length,
        replayNotifications: replayNotify.mock.calls.length
      }).toEqual({
        firstNotifications: 1,
        replayNotifications: 0
      });
      expect(conflictResponse.status).toBe(409);
      expect(await responseError(conflictResponse)).toEqual({
        error: 'idempotency key reused with a different command',
        code: 'IDEMPOTENCY_CONFLICT',
        requestId: expect.stringMatching(/^req_/),
        retryable: false
      });
    });

    test('provider completion without a project post retires the managed MeshAgent thinking placeholder', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      handlers.store.insertMessage('msg_USER00000000', sessionId, 'hi', '2026-06-30T00:00:01.000Z', 'user');
      handlers.store.insertMessage('msg_THINKING0000', sessionId, '', '2026-06-30T00:00:02.000Z', 'assistant', {
        data: {
          memberId: 'pmem_codex',
          meshSessionId: 'mesh_test00000000',
          reasoning: 'Thinking',
          source: 'managed-mesh-agent'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      handlers.store.enqueueMeshAgentInboxItem('mesh_test00000000', handlers.store.maxMessageSeq(sessionId));
      handlers.store.markMeshAgentInboxDelivered('mesh_test00000000', handlers.store.maxMessageSeq(sessionId));
      handlers.store.markMeshAgentInboxConsumed('mesh_test00000000', handlers.store.maxMessageSeq(sessionId));
      const turnEvents: Event[] = [];
      const disposeEvents = handlers.bus.subscribe(sessionId, (event) => {
        if (event.type === 'mesh.turn_settled') turnEvents.push(event);
      });

      await handlers.session.completeManagedMeshAgentProviderMessage({
        sessionId,
        meshSessionId: 'mesh_test00000000',
        projectMemberId: 'pmem_codex',
        text: 'No action needed.',
        post: false
      });
      disposeEvents();

      expect(await messages(t, sessionId)).toEqual([{ role: 'user', text: 'hi' }]);
      expect(handlers.store.findManagedMeshAgentStreamingMessage(sessionId, 'mesh_test00000000')).toBeNull();
      expect(turnEvents.map(({ type, payload }) => ({ type, payload }))).toEqual([
        { type: 'mesh.turn_settled', payload: { meshSessionId: 'mesh_test00000000' } }
      ]);
    });

    test('agent send stays out of the Workplace Project transcript', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson({ to: 'human:zeke', text: 'private note' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(200);
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('agent send and read use a direct private ledger', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson({ to: 'human:zeke', text: 'private note' }, bindingHeaders(sessionId))
      );
      expect(sent.status).toBe(200);

      const read = await t.fetch(
        '/v1/internal/native-agent/agent/read',
        json({ with: 'human:zeke' }, bindingHeaders(sessionId))
      );

      expect(read.status).toBe(200);
      expect(((await read.json()) as { messages: Array<{ peer: string; text: string }> }).messages).toMatchObject([
        { peer: 'human:zeke', text: 'private note' }
      ]);
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('agent send replays after handler recreation without a second recipient delivery', async () => {
      const handlers = buildHandlers(mockModel());
      const firstNotify = spyOn(handlers.session, 'notifyManagedMeshAgentDirectMessage');
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      addSessionMember(handlers, sessionId, 'codex', 'Lily');
      addSessionMember(handlers, sessionId, 'claude', 'Steve');
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
      createManagedNativeSession(handlers, sessionId, 'mesh_claude000000', 'claude');
      const request = {
        requestId: 'direct-replay-after-recreation',
        to: 'claude',
        text: 'durable private handoff'
      };

      const firstResponse = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson(request, bindingHeaders(sessionId, 'mesh_codex0000000', 'codex'))
      );
      expect(firstResponse.status).toBe(200);
      const first = (await firstResponse.json()) as { message: { id: MessageId; text: string; createdAt: string } };

      await t.stop();
      const recreated = buildHandlers(mockModel(), stubModelDeps(), { store: handlers.store });
      createManagedNativeSession(recreated, sessionId, 'mesh_codex0000000', 'codex');
      createManagedNativeSession(recreated, sessionId, 'mesh_claude000000', 'claude');
      const replayNotify = spyOn(recreated.session, 'notifyManagedMeshAgentDirectMessage');
      t = serveTransport(kind, createHttpTransport(recreated));
      const replayResponse = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson(request, bindingHeaders(sessionId, 'mesh_codex0000000', 'codex'))
      );
      const conflictResponse = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson(
          { ...request, text: 'changed private handoff' },
          bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
        )
      );

      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.json()).toEqual(first);
      expect(
        recreated.store
          .listNativeAgentDirectMessages('mesh_codex0000000', 'pmem_claude')
          .map(({ id, text, createdAt }) => ({ id, text, createdAt }))
      ).toEqual([{ id: first.message.id, text: first.message.text, createdAt: first.message.createdAt }]);
      expect({
        firstNotifications: firstNotify.mock.calls.length,
        replayNotifications: replayNotify.mock.calls.length
      }).toEqual({
        firstNotifications: 1,
        replayNotifications: 0
      });
      expect(conflictResponse.status).toBe(409);
      expect(await responseError(conflictResponse)).toEqual({
        error: 'idempotency key reused with a different command',
        code: 'IDEMPOTENCY_CONFLICT',
        requestId: expect.stringMatching(/^req_/),
        retryable: false
      });
    });

    test('direct private ledger is readable from both managed agent runtimes in the same project', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      addSessionMember(handlers, sessionId, 'pmem_codex', 'Lily');
      addSessionMember(handlers, sessionId, 'pmem_claude', 'Steve');
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
      createManagedNativeSession(handlers, sessionId, 'mesh_claude000000', 'claude');

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson(
          { to: 'pmem_claude', text: 'private handoff' },
          bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
        )
      );
      expect(sent.status).toBe(200);

      const readByClaude = await t.fetch(
        '/v1/internal/native-agent/agent/read',
        json({ with: 'pmem_codex' }, bindingHeaders(sessionId, 'mesh_claude000000', 'claude'))
      );

      expect(readByClaude.status).toBe(200);
      // Both sides key the conversation on canonical projectMemberIds — sender and peer are pmids on the wire.
      expect(
        ((await readByClaude.json()) as { messages: Array<{ fromAgent: string; peer: string; text: string }> }).messages
      ).toMatchObject([{ fromAgent: 'pmem_codex', peer: 'pmem_claude', text: 'private handoff' }]);
      const recordedMessages = handlers.store.listMessages(sessionId);
      expect(recordedMessages).toEqual([]);
    });

    test('agent-to-agent send records the event while the recipient runtime is offline', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      addSessionMember(handlers, sessionId, 'codex', 'Lily');
      addSessionMember(handlers, sessionId, 'claude', 'Steve');
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson(
          { to: 'claude', text: 'offline handoff' },
          bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
        )
      );

      expect(sent.status).toBe(200);
      expect(handlers.store.listMessages(sessionId)).toEqual([]);
    });

    test('direct message stays private and queued while the recipient has an unresolved ask', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      addSessionMember(handlers, sessionId, 'pmem_codex', 'Lily');
      addSessionMember(handlers, sessionId, 'pmem_claude', 'Steve');
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
      createManagedNativeSession(handlers, sessionId, 'mesh_claude000000', 'claude');

      const ask = await t.fetch(
        '/v1/internal/native-agent/project/ask',
        json(
          { blocking: true, questions: [{ question: 'Wait for a human?' }] },
          bindingHeaders(sessionId, 'mesh_claude000000', 'claude')
        )
      );
      expect(ask.status).toBe(200);

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson(
          { to: 'pmem_claude', text: 'queued private handoff' },
          bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
        )
      );
      expect(sent.status).toBe(200);
      const sentMessage = ((await sent.json()) as { message: { id: string } }).message;

      const read = await t.fetch(
        '/v1/internal/native-agent/agent/read',
        json({ with: 'pmem_codex' }, bindingHeaders(sessionId, 'mesh_claude000000', 'claude'))
      );
      expect(
        ((await read.json()) as { messages: Array<{ id: string; text: string }> }).messages.map(({ id, text }) => ({
          id,
          text
        }))
      ).toEqual([{ id: sentMessage.id, text: 'queued private handoff' }]);
      expect(handlers.store.getNativeAgentIngressForDirectMessage(sentMessage.id)).toMatchObject({
        state: 'queued',
        source: { kind: 'direct', directMessageId: sentMessage.id }
      });
      expect(
        handlers.store.listMessages(sessionId).some((message) => message.type === 'mesh_agent_direct_message')
      ).toBe(false);
    });

    test('direct message to a canonical binding-only member resolves as a member and routes to it', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
      // The recipient exists ONLY as ProjectMember + active SessionBinding (bindSessionMember shape) — no
      // legacy session_members row. It must still be recognized as a member, not fall to a private label.
      addBoundMember(handlers, sessionId, 'pmem_helper00001', 'Helper');

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson(
          { to: 'pmem_helper00001', text: 'canonical handoff' },
          bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
        )
      );
      expect(sent.status).toBe(200);
      const message = ((await sent.json()) as { message: { id: string; fromAgent: string; peer: string } }).message;
      // Resolved as a member: peer is the canonical recipient pmid (not the raw label), sender is canonical.
      expect({ fromAgent: message.fromAgent, peer: message.peer }).toEqual({
        fromAgent: 'pmem_codex',
        peer: 'pmem_helper00001'
      });
      // Routed to the recipient — an ingress item is queued for that member, never silently dropped.
      expect(handlers.store.getNativeAgentIngressForDirectMessage(message.id)).toMatchObject({
        state: 'queued',
        source: { kind: 'direct', directMessageId: message.id }
      });
    });

    test('an ambiguous direct send (with attachment) is a stable 409 with zero direct/attachment/ingress writes', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-amb-')));
      try {
        const sessionId = await createSession(t);
        createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
        // Two canonical members share the display-name alias 'Rev' — addressing it is genuinely ambiguous.
        addBoundMember(handlers, sessionId, 'pmem_reva0000001', 'Rev');
        addBoundMember(handlers, sessionId, 'pmem_revb0000001', 'Rev');
        const file = join(dir, 'attach.md');
        await writeFile(file, 'attachment body', 'utf8');
        const sqlite = (handlers.store as unknown as { sqlite: Database }).sqlite;
        const count = (table: string) => (sqlite.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

        // The request carries an attachment: if resolution ran AFTER attachment materialization, a row would leak.
        const sent = await t.fetch(
          '/v1/internal/native-agent/agent/send',
          directSendJson(
            { to: 'Rev', attachments: [{ path: file }] },
            bindingHeaders(sessionId, 'mesh_codex0000000', 'codex')
          )
        );
        expect(sent.status).toBe(409);
        expect(await responseError(sent)).toMatchObject({ code: 'AMBIGUOUS_MEMBER_TARGET' });

        const read = await t.fetch(
          '/v1/internal/native-agent/agent/read',
          json({ with: 'Rev' }, bindingHeaders(sessionId, 'mesh_codex0000000', 'codex'))
        );
        expect(read.status).toBe(409);
        expect(await responseError(read)).toMatchObject({ code: 'AMBIGUOUS_MEMBER_TARGET' });

        // Zero durable footprint across all three write surfaces, and nothing in the transcript.
        expect({
          direct: count('native_agent_direct_messages'),
          attachments: count('message_attachments'),
          ingress: count('native_agent_ingress_items')
        }).toEqual({ direct: 0, attachments: 0, ingress: 0 });
        expect(await messages(t, sessionId)).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('a 512-character member pmid round-trips through send, the durable row, and read', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_codex0000000', 'codex');
      const bigPmid = 'p'.repeat(512);
      addBoundMember(handlers, sessionId, bigPmid, 'Big');

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson({ to: bigPmid, text: 'to the big one' }, bindingHeaders(sessionId, 'mesh_codex0000000', 'codex'))
      );
      expect(sent.status).toBe(200);
      const message = ((await sent.json()) as { message: { peer: string } }).message;
      expect(message.peer).toBe(bigPmid);

      const read = await t.fetch(
        '/v1/internal/native-agent/agent/read',
        json({ with: bigPmid }, bindingHeaders(sessionId, 'mesh_codex0000000', 'codex'))
      );
      expect(read.status).toBe(200);
      const body = (await read.json()) as { with: string; messages: Array<{ peer: string; text: string }> };
      // The full-length pmid survives send → durable row → read on both the response `with` and the stored peer.
      expect(body.with).toBe(bigPmid);
      expect(body.messages).toMatchObject([{ peer: bigPmid, text: 'to the big one' }]);
    });

    test('project read returns one authorized exact message and hides missing ids', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      handlers.store.insertMessage('msg_TARGET000000', sessionId, 'target message', '2026-06-30T00:00:01.000Z', 'user');
      handlers.store.insertMessage('msg_OTHER0000000', sessionId, 'unrelated', '2026-06-30T00:00:02.000Z', 'user');

      const read = await t.fetch(
        '/v1/internal/native-agent/project/read',
        json({ sessionId, messageId: 'msg_TARGET000000' }, bindingHeaders(sessionId))
      );
      const missing = await t.fetch(
        '/v1/internal/native-agent/project/read',
        json({ sessionId, messageId: 'msg_MISSING00000' }, bindingHeaders(sessionId))
      );

      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ messages: [{ id: 'msg_TARGET000000', text: 'target message' }] });
      expect(missing.status).toBe(200);
      expect(await missing.json()).toEqual({ messages: [] });
    });

    test('project scoped commands fail outside a managed project runtime', async () => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel())));
      const sessionId = await createSession(t);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'should fail' })
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'NOT_MANAGED_MESH_AGENT' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands fail when the managed runtime session is unknown', async () => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel())));
      const sessionId = await createSession(t);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'should fail' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(404);
      expect(await responseError(res)).toMatchObject({ code: 'MESH_SESSION_NOT_FOUND' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands reject an invalid managed agent token', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson(
          { sessionId, text: 'should fail' },
          { ...bindingHeaders(sessionId), authorization: 'Bearer wrong-token' }
        )
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'INVALID_NATIVE_AGENT_TOKEN' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands reject a stopped managed runtime even with its old token', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_stopped00000', 'codex', 'stopped');

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'should fail' }, bindingHeaders(sessionId, 'mesh_stopped00000'))
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'MESH_SESSION_NOT_ACTIVE' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands reject a different session id', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const otherSessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId: otherSessionId, text: 'should fail' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'PROJECT_MISMATCH' });
      expect(await messages(t, sessionId)).toEqual([]);
      expect(await messages(t, otherSessionId)).toEqual([]);
    });

    test('a superseded managed runtime is fenced out even with a still-valid token', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      // Same owning member (pmem_codex): an OLD runtime, then a NEW one. The binding's current runtime is
      // NEW (last replaceSessionBindingRuntime wins), but the OLD row is still running with a valid token.
      createManagedNativeSession(handlers, sessionId, 'mesh_oldrun000000', 'codex');
      createManagedNativeSession(handlers, sessionId, 'mesh_newrun000000', 'codex');

      const stale = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'stale reply' }, bindingHeaders(sessionId, 'mesh_oldrun000000'))
      );
      expect(stale.status).toBe(403);
      expect(await responseError(stale)).toMatchObject({ code: 'MESH_SESSION_NOT_CURRENT' });
      // Fenced before any side effect: nothing posted, and direct.send on the stale runtime is refused too.
      expect(await messages(t, sessionId)).toEqual([]);
      const staleDirect = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        directSendJson({ to: 'human:zeke', text: 'stale dm' }, bindingHeaders(sessionId, 'mesh_oldrun000000'))
      );
      expect(staleDirect.status).toBe(403);
      expect(await responseError(staleDirect)).toMatchObject({ code: 'MESH_SESSION_NOT_CURRENT' });

      // The current runtime acts normally.
      const current = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'current reply' }, bindingHeaders(sessionId, 'mesh_newrun000000'))
      );
      expect(current.status).toBe(200);
      expect((await messages(t, sessionId)).map((m) => m.text)).toEqual(['current reply']);

      // A null current fences the (now sole) current runtime.
      handlers.store.replaceSessionBindingRuntime({
        sessionId,
        projectMemberId: 'pmem_codex',
        currentNativeRuntimeSessionId: null,
        updatedAt: new Date().toISOString()
      });
      const nulled = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'no current' }, bindingHeaders(sessionId, 'mesh_newrun000000'))
      );
      expect(nulled.status).toBe(403);
      expect(await responseError(nulled)).toMatchObject({ code: 'MESH_SESSION_NOT_CURRENT' });

      // Restore current, then leave the binding → a non-active lifecycle also fences it.
      handlers.store.replaceSessionBindingRuntime({
        sessionId,
        projectMemberId: 'pmem_codex',
        currentNativeRuntimeSessionId: 'mesh_newrun000000' as MeshSessionId,
        updatedAt: new Date().toISOString()
      });
      handlers.store.leaveSessionBinding(sessionId, 'pmem_codex', new Date().toISOString());
      const left = await t.fetch(
        '/v1/internal/native-agent/project/post',
        projectPostJson({ sessionId, text: 'after leave' }, bindingHeaders(sessionId, 'mesh_newrun000000'))
      );
      expect(left.status).toBe(403);
      expect(await responseError(left)).toMatchObject({ code: 'MESH_SESSION_NOT_CURRENT' });
      // Only the one current-runtime post ever landed.
      expect((await messages(t, sessionId)).map((m) => m.text)).toEqual(['current reply']);
    });

    test('project inbox consumes the managed agent batch exactly once', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_inbox0000000');
      handlers.store.insertMessage(
        'msg_INBOX1000000',
        sessionId,
        'please review this',
        '2026-06-30T00:00:01.000Z',
        'user'
      );
      handlers.store.enqueueMeshAgentInboxItem('mesh_inbox0000000', 1, { memberInstanceId: 'pmem_codex' });

      const first = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_inbox0000000'))
      );
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { items: Array<{ deliveryId?: string; message: { text: string } }> };
      expect(firstBody.items.map((item) => item.message.text)).toEqual(['please review this']);
      expect(firstBody.items[0]?.deliveryId?.startsWith('deliv_')).toBe(true);
      const deliveryId = firstBody.items[0]?.deliveryId;
      if (!deliveryId) throw new Error('expected delivery id');
      const deliveryRes = await t.fetch(`/v1/mesh/deliveries/${deliveryId}?transcriptTargetId=${sessionId}`);
      expect(deliveryRes.status).toBe(200);
      const deliveryBody = (await deliveryRes.json()) as {
        delivery: {
          id: string;
          sessionId: string;
          meshSessionId: string;
          triggerMessageSeq: number;
          state: string;
          outputSnapshot?: string;
          output?: string;
        };
      };
      expect(deliveryBody.delivery).toMatchObject({
        id: deliveryId,
        sessionId,
        meshSessionId: 'mesh_inbox0000000',
        triggerMessageSeq: 1,
        state: 'consumed'
      });
      expect(deliveryBody.delivery.outputSnapshot).toBeUndefined();
      expect(deliveryBody.delivery.output).toBeUndefined();
      const eventsRes = await t.fetch(
        `/v1/mesh/sessions/${deliveryBody.delivery.meshSessionId}/events/convenience?transcriptTargetId=${sessionId}`
      );
      expect(eventsRes.status).toBe(200);
      expect(await eventsRes.json()).toEqual({ frames: [] });

      const second = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_inbox0000000'))
      );
      expect(second.status).toBe(200);
      expect(((await second.json()) as { items: unknown[] }).items).toEqual([]);
    });

    test('project inbox consumes mixed room and incoming DM ingress while history reads stay pure', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const projectId = handlers.store.getSession(sessionId)?.projectId;
      if (!projectId) throw new Error('missing project id');
      createManagedNativeSession(handlers, sessionId, 'mesh_mixedinbox00', 'codex');
      handlers.store.insertMessage('msg_MIXEDROOM001', sessionId, 'room context', '2026-07-22T02:00:00.000Z', 'user');
      handlers.store.enqueueMeshAgentInboxItem('mesh_mixedinbox00', 1, { memberInstanceId: 'pmem_codex' });
      handlers.store.insertNativeAgentDirectMessage({
        id: 'msg_MIXEDDIRECT1',
        sessionId,
        meshSessionId: 'mesh_reviewersrc1',
        fromAgent: 'reviewer',
        peer: 'codex',
        text: 'private context',
        createdAt: '2026-07-22T02:00:01.000Z'
      });
      handlers.store.enqueueNativeAgentIngressItem({
        projectId,
        memberInstanceId: 'pmem_codex',
        meshSessionId: 'mesh_mixedinbox00',
        source: { kind: 'direct', directMessageId: 'msg_MIXEDDIRECT1' }
      });

      const projectHistory = await t.fetch(
        '/v1/internal/native-agent/project/read',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_mixedinbox00'))
      );
      const directHistory = await t.fetch(
        '/v1/internal/native-agent/agent/read',
        json({ with: 'reviewer' }, bindingHeaders(sessionId, 'mesh_mixedinbox00'))
      );
      expect(projectHistory.status).toBe(200);
      expect(directHistory.status).toBe(200);

      const inbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_mixedinbox00'))
      );
      expect(inbox.status).toBe(200);
      const body = (await inbox.json()) as {
        items: Array<{ source: string; ingressSeq: number; message: { text: string } }>;
      };
      expect(body.items.map((item) => [item.ingressSeq, item.source, item.message.text])).toEqual([
        [1, 'project', 'room context'],
        [2, 'direct', 'private context']
      ]);

      const repeated = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_mixedinbox00'))
      );
      expect(((await repeated.json()) as { items: unknown[] }).items).toEqual([]);
    });

    test('project inbox ack remains idempotent after inbox check consumed the messages', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_ack000000000');
      handlers.store.insertMessage('msg_ACK100000000', sessionId, 'ack me', '2026-06-30T00:00:01.000Z', 'user');
      handlers.store.enqueueMeshAgentInboxItem('mesh_ack000000000', 1, { memberInstanceId: 'pmem_codex' });

      const visible = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_ack000000000'))
      );
      expect(visible.status).toBe(200);

      const ack = await t.fetch(
        '/v1/internal/native-agent/project/inbox/ack',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_ack000000000'))
      );
      expect(ack.status).toBe(200);
      expect(await ack.json()).toEqual({
        ok: true,
        sessionId,
        cursor: 1,
        requestedCursor: 1,
        visibleCursor: 1,
        consumedDeliveryIds: [],
        deferredDeliveryIds: []
      });

      const inbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_ack000000000'))
      );
      expect(inbox.status).toBe(200);
      expect(((await inbox.json()) as { items: unknown[] }).items).toEqual([]);
    });

    test('project inbox ack without a cursor cannot hide a message whose fanout is enqueued later', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_ackrace00000');
      handlers.store.insertMessage(
        'msg_ACKRACE10000',
        sessionId,
        'first assignment',
        '2026-07-19T01:46:42.000Z',
        'user'
      );
      handlers.store.enqueueMeshAgentInboxItem('mesh_ackrace00000', 1, { memberInstanceId: 'pmem_codex' });

      const firstInbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_ackrace00000'))
      );
      expect(firstInbox.status).toBe(200);
      expect(
        (await firstInbox.json()) as {
          cursor: number;
          items: Array<{ source: string; ingressSeq: number; message: { text: string } }>;
        }
      ).toMatchObject({
        cursor: 1,
        items: [{ source: 'project', ingressSeq: 1, message: { text: 'first assignment' } }]
      });

      handlers.store.insertMessage(
        'msg_ACKRACE20000',
        sessionId,
        'delayed fanout',
        '2026-07-19T01:47:21.000Z',
        'assistant'
      );
      const ack = await t.fetch(
        '/v1/internal/native-agent/project/inbox/ack',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_ackrace00000'))
      );
      expect(ack.status).toBe(200);
      expect(await ack.json()).toMatchObject({
        ok: true,
        sessionId,
        cursor: 1,
        requestedCursor: 1,
        visibleCursor: 1,
        deferredDeliveryIds: []
      });

      handlers.store.enqueueMeshAgentInboxItem('mesh_ackrace00000', 2, { memberInstanceId: 'pmem_codex' });
      const delayedInbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ sessionId }, bindingHeaders(sessionId, 'mesh_ackrace00000'))
      );
      expect(delayedInbox.status).toBe(200);
      const delayedBody = (await delayedInbox.json()) as {
        cursor: number;
        items: Array<{ source: string; ingressSeq: number; message: { role: string; text: string } }>;
      };
      expect({
        cursor: delayedBody.cursor,
        items: delayedBody.items.map((item) => ({
          source: item.source,
          ingressSeq: item.ingressSeq,
          role: item.message.role,
          text: item.message.text
        }))
      }).toEqual({
        cursor: 2,
        items: [{ source: 'project', ingressSeq: 2, role: 'assistant', text: 'delayed fanout' }]
      });
    });

    test('runtime info exposes managed inbox cursor diagnostics', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_runtimeinfo0');
      handlers.store.insertMessage('msg_INFO10000000', sessionId, 'first pending', '2026-06-30T00:00:01.000Z', 'user');
      handlers.store.insertMessage('msg_INFO20000000', sessionId, 'second pending', '2026-06-30T00:00:02.000Z', 'user');
      handlers.store.enqueueMeshAgentInboxItem('mesh_runtimeinfo0', 1);
      handlers.store.enqueueMeshAgentInboxItem('mesh_runtimeinfo0', 2);
      handlers.store.markMeshAgentInboxDelivered('mesh_runtimeinfo0', handlers.store.maxMessageSeq(sessionId));

      const res = await t.fetch('/v1/internal/native-agent/runtime/info', {
        headers: bindingHeaders(sessionId, 'mesh_runtimeinfo0')
      });

      expect(res.status).toBe(200);
      const body = nativeAgentRuntimeInfoResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        projectMemberId: 'pmem_codex',
        sessionId,
        meshSessionId: 'mesh_runtimeinfo0',
        lastDeliveredSeq: 2,
        lastVisibleSeq: 0,
        pendingInboxCount: 2
      });
      expect(body.runtime).toMatchObject({
        id: 'mesh_runtimeinfo0',
        sessionId,
        agentName: 'codex',
        provider: 'codex',
        workingPath: '/tmp/project',
        runtimeRole: 'managed-project-agent',
        agentRuntimeId: 'mesh_runtimeinfo0',
        lifecycle: { state: 'active' },
        activity: { state: 'running', pid: 123, queuedTurnCount: 0 },
        connection: { state: 'inactive' },
        session: { providerSessionRef: null },
        lastDeliveredSeq: 2,
        lastVisibleSeq: 0,
        pendingApprovalCount: 0
      });
      expect(body.runtime && 'pid' in body.runtime).toBe(false);
      expect(body.runtime && 'outputSnapshot' in body.runtime).toBe(false);
      expect(body.runtime && 'output' in body.runtime).toBe(false);
      expect(body.runtime && 'exitCode' in body.runtime).toBe(false);
    });

    test('MeshAgent events endpoint returns an empty page for persisted managed sessions without provider events', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'mesh_observeuqrOV', 'codex', 'stopped');

      const res = await t.fetch(
        `/v1/mesh/sessions/mesh_observeuqrOV/events/convenience?transcriptTargetId=${sessionId}`
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ frames: [] });
    });

    test('MeshAgent events endpoint does not fall back to persisted managed output', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      // A stopped managed session can retain output for diagnostics, but event pages read only the
      // adapter-owned event source. Without reachable provider events the page is empty; persisted
      // output is deliberately not reused as an event source.
      createManagedNativeSession(
        handlers,
        sessionId,
        'mesh_observes7pOD',
        'codex',
        'stopped',
        '/tmp/project',
        '{"type":"result","result":"done"}\n'
      );

      const res = await t.fetch(
        `/v1/mesh/sessions/mesh_observes7pOD/events/convenience?transcriptTargetId=${sessionId}`
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ frames: [] });
    });
  });
}
