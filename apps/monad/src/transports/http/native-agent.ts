import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import {
  type AttachmentReadResponse,
  attachmentPreviewText,
  daemonHttpContract,
  isPreviewableAttachmentMime,
  type MessageAttachmentRef,
  NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX,
  type NativeAgentAttachmentInput,
  newId,
  type ProjectId
} from '@monad/protocol';
import { Elysia } from 'elysia';

import { HandlerError } from '@/handlers/handler-error.ts';
import { nativeCliProjectMemberDisplayNameForAgent } from '@/handlers/session/handlers/messaging-members.ts';

function runtimeBinding(request: Request) {
  return {
    nativeCliSessionId: request.headers.get('x-monad-native-cli-session-id')
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatchesHash(providedToken: string, expectedHash: string): boolean {
  const provided = Buffer.from(hashToken(providedToken), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function managedNativeCliDisplayName(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  projectId: ProjectId,
  agentId: string
): string {
  const session = store.getSession(projectId) ?? store.getWorkplaceProject(projectId);
  return session ? nativeCliProjectMemberDisplayNameForAgent(session, agentId) : agentId;
}

function readableAnswer(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed.join(', ');
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Plain text answer.
  }
  return answer;
}

/** The stdin-notice rendering of a message with attachments: the persisted text (or preview) plus
 *  one structured reference marker per file, so agents woken over stdin know which files hold the
 *  full content. Persisted message text stays marker-free — clients render the structured refs. */
function attachmentNoticeText(text: string, refs: readonly MessageAttachmentRef[]): string {
  const markers = refs.map((ref) => `[Attachment ${ref.id}: ${ref.name} (${ref.bytes} bytes) — file at ${ref.path}]`);
  return [text, markers.join('\n')].filter(Boolean).join('\n\n');
}

// Cap for the inline JSON preview read (the wall's expandable preview); download streams the full file.
const ATTACHMENT_INLINE_READ_MAX = 1_000_000;
// Bounded preview head read at registration time (bytes; ~4x the preview char cap for multi-byte text).
const ATTACHMENT_PREVIEW_READ_BYTES = NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX * 4;

/** RFC 6266/5987 content-disposition: ASCII fallback + UTF-8 `filename*` so non-Latin-1 names
 *  (e.g. Chinese) neither break the Response header ByteString constraint nor lose the name. */
function attachmentContentDisposition(name: string): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Snapshot a referenced local file into an attachment ref: realpath + containment inside the
 *  runtime's working directory (a managed agent may only reference files it could read itself —
 *  the daemon must not become a read-anything deputy), stat for size, sniff mime from the
 *  extension, and read a bounded head as the preview when the content is text-like. The file must
 *  exist at post time; afterwards it keeps reference semantics (edits/deletes affect later reads). */
async function snapshotAttachmentInput(
  input: NativeAgentAttachmentInput,
  workspaceRealpath: string
): Promise<{ ref: Omit<MessageAttachmentRef, 'id' | 'createdAt'>; preview: string }> {
  let resolved: string;
  let size: number;
  try {
    resolved = await realpath(input.path);
    const stats = await stat(resolved);
    if (!stats.isFile()) throw new Error('not a regular file');
    size = stats.size;
  } catch {
    throw new HandlerError(
      'invalid',
      `attachment file not found or unreadable: ${input.path}`,
      'ATTACHMENT_FILE_MISSING'
    );
  }
  if (resolved !== workspaceRealpath && !resolved.startsWith(workspaceRealpath + sep)) {
    throw new HandlerError(
      'forbidden',
      `attachment path is outside the project working directory: ${input.path}`,
      'ATTACHMENT_PATH_OUTSIDE_WORKSPACE'
    );
  }
  const sniffed = Bun.file(resolved).type.split(';')[0]?.trim();
  const mime = input.mime ?? (sniffed || 'application/octet-stream');
  let preview = '';
  if (isPreviewableAttachmentMime(mime) && size > 0) {
    const truncated = size > ATTACHMENT_PREVIEW_READ_BYTES;
    const head = await Bun.file(resolved).slice(0, Math.min(size, ATTACHMENT_PREVIEW_READ_BYTES)).text();
    // A byte-bounded read can cut a multi-byte UTF-8 sequence — trim the resulting replacement
    // chars only when the read WAS truncated (a full read's trailing U+FFFD is real content).
    preview = attachmentPreviewText(truncated ? head.replace(/�+$/, '') : head);
  }
  return {
    ref: { path: resolved, name: input.name ?? basename(resolved), mime, bytes: size },
    preview
  };
}

function projectQaWallText(args: { question: string; options: readonly string[]; answer?: string }): string {
  return [
    `Q: ${args.question}`,
    ...(args.options.length ? [`Options: ${args.options.join(' | ')}`] : []),
    ...(args.answer === undefined ? [] : [`A: ${args.answer.trim() ? readableAnswer(args.answer) : '(skipped)'}`])
  ].join('\n');
}

function projectAskSummary(args: {
  askerName: string;
  question: string;
  options: readonly string[];
  answer: string;
}): string {
  return [
    'Project Q&A summary:',
    `Asked by: ${args.askerName}`,
    `Question: ${args.question}`,
    ...(args.options.length ? [`Options: ${args.options.join(' | ')}`] : []),
    `User answer: ${readableAnswer(args.answer)}`,
    '',
    'Use this as shared project context. Do not repeat it unless it changes your task-relevant response.'
  ].join('\n');
}

function enqueueProjectSummaryForManagedRuntimes(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore'],
  projectId: ProjectId,
  summarySeq: number,
  exceptNativeCliSessionId: string
): void {
  for (const session of store.listNativeCliSessionsForTranscriptTarget(projectId)) {
    if (session.id === exceptNativeCliSessionId) continue;
    if (session.runtimeRole !== 'managed-project-agent') continue;
    store.enqueueNativeCliInboxItem(session.id, summarySeq);
  }
}

export function createNativeAgentController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const store = handlers._nativeAgentStore;
  const contracts = daemonHttpContract.nativeAgent;
  const requireManagedBinding = (request: Request) => {
    const binding = runtimeBinding(request);
    if (!binding.nativeCliSessionId) {
      throw new HandlerError(
        'forbidden',
        'current runtime is not a project-managed native CLI agent',
        'NOT_MANAGED_NATIVE_CLI'
      );
    }
    const nativeSession = store.getNativeCliSession(binding.nativeCliSessionId);
    if (!nativeSession) {
      throw new HandlerError(
        'not_found',
        `native CLI session not found: ${binding.nativeCliSessionId}`,
        'NATIVE_CLI_SESSION_NOT_FOUND'
      );
    }
    if (nativeSession.runtimeRole !== 'managed-project-agent') {
      throw new HandlerError(
        'forbidden',
        'current runtime is not a project-managed native CLI agent',
        'NOT_MANAGED_NATIVE_CLI'
      );
    }
    if (nativeSession.state !== 'running') {
      throw new HandlerError('forbidden', 'managed native CLI session is not active', 'NATIVE_CLI_SESSION_NOT_ACTIVE');
    }
    if (!nativeSession.transcriptTargetId.startsWith('prj_')) {
      throw new HandlerError(
        'forbidden',
        'managed native CLI session is not bound to a Workplace Project',
        'NOT_PROJECT_MANAGED_NATIVE_CLI'
      );
    }
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!nativeSession.agentRuntimeTokenHash || !tokenMatchesHash(token, nativeSession.agentRuntimeTokenHash)) {
      throw new HandlerError('forbidden', 'invalid managed native CLI agent token', 'INVALID_NATIVE_AGENT_TOKEN');
    }
    return {
      binding: {
        agentId: nativeSession.agentName,
        projectId: nativeSession.transcriptTargetId as ProjectId,
        nativeCliSessionId: binding.nativeCliSessionId
      },
      nativeSession
    };
  };
  /** Resolve a post/send body into its persisted + delivery forms. Registers the file references
   *  under the bound project (snapshots run first for ALL inputs so one bad file fails the request
   *  before anything registers; registration itself is atomic). Returns:
   *  - `text`: what the message row stores — the inline body, or the first text preview when the
   *    message is attachment-only. Marker-free; clients render the structured refs.
   *  - `noticeText`: what stdin notices carry — `text` plus one reference marker per file.
   *  - `attachments`: the registered refs for message data / responses. */
  const resolveAttachmentPayload = async (
    body: { text?: string; attachments?: NativeAgentAttachmentInput[] },
    binding: { projectId: ProjectId; agentId: string },
    workingPath: string
  ): Promise<{ text: string; noticeText: string; attachments: MessageAttachmentRef[] }> => {
    if (!body.attachments?.length) {
      const text = body.text ?? '';
      return { text, noticeText: text, attachments: [] };
    }
    const workspaceRealpath = await realpath(workingPath).catch(() => {
      throw new HandlerError(
        'invalid',
        `project working directory is not accessible: ${workingPath}`,
        'ATTACHMENT_WORKSPACE_MISSING'
      );
    });
    const snapshots = await Promise.all(
      body.attachments.map((input) => snapshotAttachmentInput(input, workspaceRealpath))
    );
    const createdAt = new Date().toISOString();
    const attachments = store.registerMessageAttachments(
      snapshots.map(({ ref, preview }) => ({
        id: newId('att'),
        projectId: binding.projectId,
        ...ref,
        preview,
        createdBy: binding.agentId,
        createdAt
      }))
    );
    const text = body.text ?? snapshots.find((snapshot) => snapshot.preview)?.preview ?? '';
    return { text, noticeText: attachmentNoticeText(text, attachments), attachments };
  };
  return (
    new Elysia({ tags: ['http-only'] })
      .post(
        '/internal/native-agent/project/post',
        async ({ body, request }) => {
          const { binding, nativeSession } = requireManagedBinding(request);
          const projectId = body.projectId ?? binding.projectId;
          if (binding.projectId !== projectId) {
            throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
          }
          const transcriptTargetId = projectId;
          // File attachments: content stays in the referenced files; the wall message, fan-out
          // notices, and inbox copies carry only a bounded preview + the structured references.
          const { text, noticeText, attachments } = await resolveAttachmentPayload(
            body,
            binding,
            nativeSession.workingPath
          );
          let messageId: `msg_${string}`;
          try {
            const completed = await handlers.session.completeManagedNativeCliProjectMessage({
              sessionId: transcriptTargetId,
              nativeCliSessionId: binding.nativeCliSessionId,
              agentName: binding.agentId,
              text,
              threadId: body.threadId,
              attachments
            });
            messageId = completed.messageId ?? newId('msg');
          } catch (err) {
            // The registered = referenced-by-a-message gate must stay honest: a failed post
            // unregisters its refs so orphan ids can't keep files reachable via /v1/attachments.
            store.deleteMessageAttachments(attachments.map((ref) => ref.id));
            throw err;
          }
          const createdAt = new Date().toISOString();
          store.markNativeCliInboxConsumed(binding.nativeCliSessionId, store.maxMessageSeq(transcriptTargetId));
          await handlers.session.notifyManagedNativeCliProjectMembers({
            sessionId: transcriptTargetId,
            text: noticeText,
            sender: { kind: 'native-cli-agent', name: binding.agentId, id: binding.agentId },
            exceptAgentName: binding.agentId
          });
          return {
            ok: true,
            message: {
              id: messageId,
              projectId,
              text,
              ...(attachments.length ? { attachments } : {}),
              createdAt
            }
          };
        },
        { body: contracts.projectPost.body, response: contracts.projectPost.response }
      )
      .post(
        '/internal/native-agent/project/ask',
        async ({ body, request, server }) => {
          const { binding } = requireManagedBinding(request);
          const projectId = body.projectId ?? binding.projectId;
          if (binding.projectId !== projectId) {
            throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
          }
          // The response is held open until a human answers — indefinitely by design. Bun's
          // default idleTimeout closes a silent connection after ~10s, which would drop the
          // answer while the clarify stays pending — disable it for this request only.
          server?.timeout(request, 0);
          const askerName = managedNativeCliDisplayName(store, projectId, binding.agentId);
          const wallQuestion = projectQaWallText({ question: body.question, options: body.options });
          const wall = handlers.session.beginProjectQaWallMessage({
            sessionId: projectId,
            agentName: askerName,
            text: wallQuestion
          });
          const result = await handlers.clarify.askStructured(
            projectId,
            {
              question: body.question,
              options: body.options,
              mode: body.mode,
              allowOther: body.allowOther,
              asker: { id: binding.agentId, name: askerName }
            },
            { waitForever: true }
          );
          handlers.session.completeProjectQaWallMessage({
            sessionId: projectId,
            messageId: wall.messageId,
            agentName: askerName,
            text: projectQaWallText({ question: body.question, options: body.options, answer: result.answer })
          });
          if (result.requestId && result.answer.trim()) {
            const summary = projectAskSummary({
              askerName,
              question: body.question,
              options: body.options,
              answer: result.answer
            });
            store.insertMessage(newId('msg'), projectId, summary, new Date().toISOString(), 'system', {
              data: {
                source: 'managed-native-cli-question',
                requestId: result.requestId,
                agentName: binding.agentId,
                nativeCliSessionId: binding.nativeCliSessionId
              },
              includeInContext: true
            });
            const summarySeq = store.maxMessageSeq(projectId);
            enqueueProjectSummaryForManagedRuntimes(store, projectId, summarySeq, binding.nativeCliSessionId);
            await handlers.session.notifyManagedNativeCliProjectMembers({
              sessionId: projectId,
              text: summary,
              sender: { kind: 'system', name: 'Project Q&A summary', id: 'system:project-qa' },
              exceptAgentName: binding.agentId
            });
          }
          return { ok: true, requestId: result.requestId, answer: result.answer };
        },
        { body: contracts.projectAsk.body, response: contracts.projectAsk.response }
      )
      .post(
        '/internal/native-agent/project/read',
        ({ body, request }) => {
          const { binding } = requireManagedBinding(request);
          const projectId = body.projectId ?? binding.projectId;
          if (binding.projectId !== projectId) {
            throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
          }
          const transcriptTargetId = projectId;
          const messages = store.listMessages(transcriptTargetId, {
            limit: body.limit ?? 50,
            threadId: body.threadId,
            before: body.before,
            after: body.after,
            around: body.around,
            latest: !body.before && !body.after && !body.around
          });
          if (!body.threadId && !body.before && !body.after && !body.around) {
            const visibleSeq = store.maxMessageSeq(transcriptTargetId);
            if (visibleSeq > 0) store.markNativeCliInboxVisible(binding.nativeCliSessionId, visibleSeq);
          }
          return { messages };
        },
        { body: contracts.projectRead.body, response: contracts.projectRead.response }
      )
      .post(
        '/internal/native-agent/project/inbox',
        ({ body, request }) => {
          const { binding, nativeSession } = requireManagedBinding(request);
          const projectId = body?.projectId ?? binding.projectId;
          if (projectId !== binding.projectId) {
            throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
          }
          const nativeCliSessionId = binding.nativeCliSessionId;
          const items = store.listNativeCliInbox(nativeCliSessionId);
          const cursor = items.at(-1)?.seq ?? nativeSession.lastVisibleSeq;
          if (items.length > 0) store.markNativeCliInboxVisible(nativeCliSessionId, cursor);
          return { items, projectId, cursor };
        },
        { body: contracts.projectInbox.body, response: contracts.projectInbox.response }
      )
      .post(
        '/internal/native-agent/project/inbox/ack',
        ({ body, request }) => {
          const { binding } = requireManagedBinding(request);
          const projectId = body?.projectId ?? binding.projectId;
          if (projectId !== binding.projectId) {
            throw new HandlerError('forbidden', 'project id does not match managed runtime', 'PROJECT_MISMATCH');
          }
          const cursor = body?.cursor ?? store.maxMessageSeq(projectId);
          store.markNativeCliInboxConsumed(binding.nativeCliSessionId, cursor);
          return { ok: true, projectId, cursor };
        },
        { body: contracts.projectInboxAck.body, response: contracts.projectInboxAck.response }
      )
      .post(
        '/internal/native-agent/agent/send',
        async ({ body, request }) => {
          const { binding, nativeSession } = requireManagedBinding(request);
          // File attachments: the durable direct-message row and the peer's stdin notice carry only
          // a bounded preview + the structured references; content stays in the files.
          const { text, noticeText, attachments } = await resolveAttachmentPayload(
            body,
            binding,
            nativeSession.workingPath
          );
          const message = {
            id: newId('msg'),
            projectId: binding.projectId,
            nativeCliSessionId: binding.nativeCliSessionId,
            fromAgent: binding.agentId,
            peer: body.to,
            text,
            ...(attachments.length ? { attachments } : {}),
            createdAt: new Date().toISOString()
          };
          try {
            store.insertNativeAgentDirectMessage(message);
          } catch (err) {
            store.deleteMessageAttachments(attachments.map((ref) => ref.id));
            throw err;
          }
          await handlers.session.notifyManagedNativeCliDirectMessage({
            sessionId: binding.projectId,
            fromAgentName: binding.agentId,
            to: body.to,
            text: noticeText
          });
          return { ok: true, direct: true, message };
        },
        { body: contracts.agentSend.body, response: contracts.agentSend.response }
      )
      .post(
        '/internal/native-agent/agent/read',
        ({ body, request }) => {
          const { binding } = requireManagedBinding(request);
          const messages = store.listNativeAgentDirectMessages(binding.nativeCliSessionId, body.with, {
            before: body.before,
            after: body.after,
            limit: body.limit ?? 50
          });
          return { with: body.with, messages, before: body.before, after: body.after };
        },
        { body: contracts.agentRead.body, response: contracts.agentRead.response }
      )
      // Client-facing (web wall) read: same /v1 auth as every other daemon endpoint (localhost/unix
      // trusted, remote needs the daemon Bearer). Serves ONLY files registered by a message post —
      // the id gate means this never exposes arbitrary paths. Content is read from the referenced
      // file at request time (reference semantics: a moved/deleted file returns 410).
      // `?download=1` streams the raw file and bypasses the response schema.
      .get('/attachments/:id', async ({ params, request }) => {
        const attachment = store.getMessageAttachment(params.id);
        if (!attachment) throw new HandlerError('not_found', `attachment not found: ${params.id}`);
        const { projectId: _projectId, preview: _preview, ...ref } = attachment;
        const file = Bun.file(attachment.path);
        if (!(await file.exists())) {
          return new Response(JSON.stringify({ error: `attachment file no longer exists: ${attachment.path}` }), {
            status: 410,
            headers: { 'content-type': 'application/json' }
          });
        }
        const url = new URL(request.url);
        if (url.searchParams.get('download') === '1') {
          return new Response(file, {
            headers: {
              'content-type': attachment.mime,
              'content-disposition': attachmentContentDisposition(attachment.name)
            }
          });
        }
        const previewable = isPreviewableAttachmentMime(attachment.mime);
        const size = file.size;
        const text = previewable ? await file.slice(0, Math.min(size, ATTACHMENT_INLINE_READ_MAX)).text() : '';
        // Typed against the protocol contract (daemonHttpContract.nativeAgent.attachmentRead).
        // Runtime response validation is skipped because the download/410 branches return raw
        // Response objects, which Elysia's schema option cannot union with.
        const payload: AttachmentReadResponse = {
          attachment: ref,
          text,
          truncated: previewable && size > ATTACHMENT_INLINE_READ_MAX
        };
        return payload;
      })
      .get(
        '/internal/native-agent/runtime/info',
        ({ request }) => {
          const { binding, nativeSession } = requireManagedBinding(request);
          return {
            ...binding,
            serverUrl: new URL(request.url).origin,
            workdir: nativeSession.workingPath,
            providerSessionRef: nativeSession.providerSessionRef,
            lastDeliveredSeq: nativeSession.lastDeliveredSeq,
            lastVisibleSeq: nativeSession.lastVisibleSeq,
            pendingInboxCount: store.countNativeCliInbox(binding.nativeCliSessionId)
          };
        },
        { response: contracts.runtimeInfo.response }
      )
  );
}
