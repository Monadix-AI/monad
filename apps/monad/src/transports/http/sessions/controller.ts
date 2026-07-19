import type {
  GenerateMessageResponse,
  ListMessagesResponse,
  SessionId,
  SessionMemberUiObservationFrame
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { IdempotencyStore } from '#/transports/http/idempotency.ts';

import {
  configureRuntimeRequestSchema,
  daemonHttpContract,
  eventIdSchema,
  listUiItemsQuerySchema,
  listUiItemsResponseSchema,
  messageIdSchema,
  okResponseSchema,
  responseInstanceSchema,
  sessionIdSchema,
  sessionMemberUiObservationFrameSchema,
  workspaceActionRequestSchema,
  workspaceActionResponseSchema,
  workspaceGitSchema,
  workspaceMetaSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { buildSessionOrigin } from '#/handlers/session/origin.ts';
import { idempotentJsonHandler } from '#/transports/http/idempotency.ts';
import { createPushSseResponse, encodeSseFrame } from '#/transports/http/sessions/sse.ts';
import {
  createSessionEventsSseResponse,
  createSessionLogsSseResponse,
  createSessionMessageGenerationSseResponse,
  createSessionMessageSseResponse,
  createSessionUiEventsSseResponse,
  wantsInlineSessionStream
} from '#/transports/http/sessions/stream.ts';

// The HTTP-only routes in this otherwise-universal controller (SSE events, member ui-observation,
// out-of-band runtime config) declare their contracts inline from protocol leaf schemas — they have no
// JSON-RPC twin, so they don't belong in daemonHttpContract (which mirrors the universal METHOD_TABLE
// methods). Mirrors `/external-agent-sessions/:id/ui-observation{,-stream}` in transports/http/external-agent.ts.
const sessionParams = z.object({ id: sessionIdSchema });
const sessionMessageParams = sessionParams.extend({ messageId: messageIdSchema });
const sessionMemberParams = z.object({ id: sessionIdSchema, memberId: z.string().min(1) });

// The neutral UI plane for a session member with no `externalAgentSessionId` of its own (today, the
// `monad` built-in-agent member) — see `session-member-observation.ts`. Unlike the external-agent SSE
// (which force-closes on any non-`live` frame, since a stopped provider session never resumes), a
// `history`/idle monad member can still start a fresh turn later, so only the terminal `unavailable`
// state (unknown member) ends the stream.
function createSessionMemberUiObservationSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  sessionId: SessionId,
  memberId: string,
  encoder: TextEncoder
): Response {
  return createPushSseResponse<SessionMemberUiObservationFrame>({
    encoder,
    encode: (frame) => encodeSseFrame({ event: 'session_member.ui_observation', data: frame }, encoder),
    subscribe: (emit) =>
      handlers.session.subscribeMemberUiObservation({ sessionId, memberId }, (frame) =>
        emit(frame, frame.state === 'unavailable')
      )
  });
}

type ReqServer = { requestIP(req: Request): { address: string } | null } | null;

// The daemon sits behind the web app's /api proxy, so the socket peer is the proxy — prefer the
// forwarded client IP. We trust the header because the proxy is owner-controlled (loopback); a
// hostile X-Forwarded-For only spoofs an audit-only field, never an access decision.
function clientIp(server: ReqServer, request: Request): string | undefined {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || undefined; // first hop = original client
  const xri = request.headers.get('x-real-ip')?.trim();
  if (xri) return xri;
  return server?.requestIP(request)?.address;
}

/** Highest-priority language tag from an Accept-Language header (drops q-values). */
function preferredLocale(request: Request): string | undefined {
  const header = request.headers.get('accept-language');
  if (!header) return undefined;
  // "en-US,en;q=0.9,fr;q=0.8" → "en-US" (the first tag wins; we ignore explicit q-ordering).
  return header.split(',')[0]?.split(';')[0]?.trim() || undefined;
}

/** Audit-only environment snapshot from the request (never fed to the model). */
function httpEnv(server: ReqServer, request: Request) {
  return {
    ip: clientIp(server, request),
    userAgent: request.headers.get('user-agent') ?? undefined,
    referer: request.headers.get('referer') ?? undefined,
    locale: preferredLocale(request)
  };
}

export function createSessionsController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  encoder: TextEncoder,
  idempotencyStore: IdempotencyStore
) {
  const contracts = daemonHttpContract.sessions;
  type CreateSessionContext = {
    body: z.infer<typeof contracts.create.body>;
    request: Request;
    server: ReqServer;
  };

  return (
    new Elysia()
      .get('/sessions', async ({ query }) => handlers.session.list(query), {
        query: contracts.list.query,
        response: contracts.list.response,
        detail: {
          summary: 'List sessions',
          description: 'Returns sessions filtered by archived/state query parameters.'
        }
      })
      .post(
        '/sessions',
        idempotentJsonHandler<CreateSessionContext>({
          route: () => '/v1/sessions',
          store: idempotencyStore,
          handler: async ({ body, server, request }) => {
            // Identity (surface/client) is client-declared (a TUI sends surface:'tui'); transport and
            // env are filled server-side and never trusted from the body. env is audit-only.
            const origin = buildSessionOrigin({
              transport: 'http',
              surface: body.origin?.surface ?? 'web',
              client: body.origin?.client ?? 'monad-web',
              clientVersion: body.origin?.clientVersion,
              writableBy: body.origin?.writableBy,
              branchableBy: body.origin?.branchableBy,
              ext: body.origin?.ext,
              env: httpEnv(server, request)
            });
            const result = await handlers.session.create({
              title: body.title,
              agentId: body.agentId,
              origin,
              cwd: body.cwd
            });
            return Response.json(result, {
              headers: { location: `/v1/sessions/${result.sessionId}` },
              status: 201
            });
          }
        }),
        {
          body: contracts.create.body,
          response: contracts.create.response,
          detail: { summary: 'Create session', description: 'Creates a new session with the provided title.' }
        }
      )
      // Elysia's radix trie gives static segments priority over dynamic ones — `/sessions/search`
      // will never be captured by `/sessions/:id` regardless of registration order.
      .get('/sessions/search', async ({ query }) => handlers.session.search(query), {
        query: contracts.search.query,
        response: contracts.search.response,
        detail: {
          summary: 'Search session messages',
          description: 'Searches messages by keyword, semantic, or hybrid mode.'
        }
      })
      .get(
        '/sessions/:id',
        async ({ params, set }) => {
          const result = await handlers.session.get({ id: params.id });
          set.headers.etag = `"${result.session.updatedAt}"`;
          return result;
        },
        {
          params: contracts.get.params,
          response: contracts.get.response,
          detail: { summary: 'Get session', description: 'Returns one session by id.' }
        }
      )
      .patch(
        '/sessions/:id',
        async ({ params, body, request, set, status }) => {
          const ifMatch = request.headers.get('if-match');
          if (ifMatch && ifMatch !== '*') {
            // Pre-check: tiny TOCTOU window is acceptable — SQLite is single-writer and
            // the race window (read → update) is sub-millisecond in practice.
            const current = await handlers.session.get({ id: params.id });
            const etag = `"${current.session.updatedAt}"`;
            if (ifMatch !== etag) {
              set.headers.etag = etag;
              return status(412, { error: 'precondition failed', code: 'PRECONDITION_FAILED' });
            }
          }
          const result = await handlers.session.update({ id: params.id, ...body });
          set.headers.etag = `"${result.session.updatedAt}"`;
          return result;
        },
        {
          params: contracts.update.params,
          body: contracts.update.body,
          response: contracts.update.response,
          detail: { summary: 'Update session', description: 'Updates title/state/archive fields on a session.' }
        }
      )
      .delete('/sessions/:id', async ({ params }) => handlers.session.delete({ id: params.id }), {
        params: contracts.delete.params,
        response: contracts.delete.response,
        detail: {
          summary: 'Delete session',
          description: 'Queues the session for deletion during the undo grace period.'
        }
      })
      .post('/sessions/:id/undo-delete', async ({ params }) => handlers.session.undoDelete({ id: params.id }), {
        params: contracts.undoDelete.params,
        response: contracts.undoDelete.response,
        detail: {
          summary: 'Undo session delete',
          description: 'Cancels a queued session deletion while the grace period is still open.'
        }
      })
      .post('/sessions/:id/abort', async ({ params }) => handlers.session.abort({ id: params.id }), {
        params: contracts.abort.params,
        response: contracts.abort.response,
        detail: { summary: 'Abort session run', description: 'Cancels an in-flight run for a session if one exists.' }
      })
      .post('/sessions/:id/reset', async ({ params }) => handlers.session.reset({ id: params.id }), {
        params: contracts.reset.params,
        response: contracts.reset.response,
        detail: {
          summary: 'Reset session',
          description: 'Clears all messages and events from a session, keeping the session itself.'
        }
      })
      .post(
        '/sessions/:id/branch',
        async ({ params, body, server, request, status }) => {
          // The child's origin is stamped from THIS (branching) transport, not the parent's.
          const origin = buildSessionOrigin({
            transport: 'http',
            surface: body.origin?.surface ?? 'web',
            client: body.origin?.client ?? 'monad-web',
            clientVersion: body.origin?.clientVersion,
            writableBy: body.origin?.writableBy,
            branchableBy: body.origin?.branchableBy,
            ext: body.origin?.ext,
            env: httpEnv(server, request)
          });
          return status(
            201,
            await handlers.session.branch({ id: params.id, title: body.title, atMessageId: body.atMessageId, origin })
          );
        },
        {
          params: contracts.branch.params,
          body: contracts.branch.body,
          response: contracts.branch.response,
          detail: { summary: 'Branch session', description: 'Copies history into a new independent session.' }
        }
      )
      .put(
        '/sessions/:id/runtime',
        async ({ params, body }) => handlers.session.configureRuntime({ id: params.id, ...body }),
        {
          params: sessionParams,
          body: configureRuntimeRequestSchema,
          response: { 200: okResponseSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Configure session runtime',
            description: "Sets out-of-band per-turn execution config (e.g. the ACP editor's sandbox roots)."
          }
        }
      )
      .get(
        '/sessions/:id/delegates',
        async ({ params, query }) => handlers.session.delegates({ id: params.id, limit: query.limit }),
        {
          params: sessionParams,
          query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
          detail: {
            tags: ['http-only'],
            summary: 'List session delegates',
            description: 'Returns ACP delegate lifecycle records for a session (live + evicted), newest first.'
          }
        }
      )
      .post(
        '/sessions/:id/restore',
        async ({ params, body }) => handlers.session.restore({ id: params.id, toMessageId: body.toMessageId }),
        {
          params: contracts.restore.params,
          body: contracts.restore.body,
          response: contracts.restore.response,
          detail: {
            summary: 'Restore session',
            description: 'Restores a session to the specified user message checkpoint.'
          }
        }
      )
      .get(
        '/sessions/:id/messages',
        async ({ params, query }): Promise<ListMessagesResponse> =>
          handlers.session.messages({
            id: params.id,
            limit: query.limit,
            before: query.before,
            includeInactive: query.includeInactive
          }),
        {
          params: contracts.messages.params,
          query: contracts.messages.query,
          response: contracts.messages.response,
          detail: {
            summary: 'List session messages',
            description: 'Returns session messages with pagination options.'
          }
        }
      )
      .get(
        '/sessions/:id/ui-items',
        async ({ params, query }) =>
          handlers.session.uiItems({
            id: params.id,
            limit: query.limit,
            before: query.before,
            after: query.after,
            around: query.around,
            includeInactive: query.includeInactive
          }),
        {
          params: sessionParams,
          query: listUiItemsQuerySchema,
          response: { 200: listUiItemsResponseSchema },
          detail: {
            tags: ['http-only'],
            summary: 'List projected session UI items',
            description: 'Returns server-projected transcript and tool timeline items for the session.'
          }
        }
      )
      .get('/sessions/:id/workspace-git', async ({ params }) => handlers.session.workspaceGit({ id: params.id }), {
        params: sessionParams,
        response: { 200: workspaceGitSchema },
        detail: {
          tags: ['http-only'],
          summary: 'Git status of the session working folder',
          description: 'Deprecated alias for workspace-meta.git.'
        }
      })
      .get('/sessions/:id/workspace-meta', async ({ params }) => handlers.session.workspaceMeta({ id: params.id }), {
        params: sessionParams,
        response: { 200: workspaceMetaSchema },
        detail: {
          tags: ['http-only'],
          summary: 'Workspace metadata for the session working folder',
          description: 'Returns best-effort metadata slices for the session’s working folder.'
        }
      })
      .post(
        '/sessions/:id/workspace-action',
        async ({ params, body }) => handlers.session.workspaceAction({ id: params.id, action: body.action }),
        {
          params: sessionParams,
          body: workspaceActionRequestSchema,
          response: { 200: workspaceActionResponseSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Open the session working folder on the daemon host',
            description: 'Runs a platform-native file manager or terminal action for the session working folder.'
          }
        }
      )
      .post(
        '/sessions/:id/messages',
        async ({ params, body, headers, request }) => {
          if (body.steer || !wantsInlineSessionStream(headers.accept) || body.generate === false) {
            return idempotentJsonHandler({
              route: () => `/v1/sessions/${params.id}/messages`,
              store: idempotencyStore,
              handler: async () =>
                Response.json(
                  await handlers.session.send({
                    sessionId: params.id,
                    text: body.text,
                    generate: body.generate,
                    steer: body.steer,
                    steerMessages: body.steerMessages,
                    continueFromHistory: body.continueFromHistory,
                    ambientContext: body.ambientContext
                  })
                )
            })({ body, request });
          }

          return createSessionMessageSseResponse({
            handlers,
            sessionId: params.id,
            text: body.text,
            continueFromHistory: body.continueFromHistory,
            ambientContext: body.ambientContext,
            encoder
          });
        },
        {
          params: contracts.send.params,
          body: contracts.send.body,
          headers: contracts.send.headers,
          response: contracts.send.response,
          detail: {
            summary: 'Send session message',
            description: 'Sends a user message; can return SSE stream when accept header requests it.'
          }
        }
      )
      .post(
        '/sessions/:id/messages/block',
        async ({ params, body }): Promise<GenerateMessageResponse> =>
          handlers.session.generate({ sessionId: params.id, text: body.text }),
        {
          params: contracts.generate.params,
          body: contracts.generate.body,
          response: contracts.generate.response,
          detail: {
            summary: 'Generate blocking response',
            description: 'Runs a turn to completion and returns the full assistant message.'
          }
        }
      )
      .get(
        '/sessions/:id/members',
        async ({ params }) => handlers.session.listSessionMembers({ sessionId: params.id }),
        {
          params: contracts.members.list.params,
          response: contracts.members.list.response,
          detail: {
            tags: ['http-only'],
            summary: 'List session members',
            description: 'Returns the live member bindings for a session.'
          }
        }
      )
      .post(
        '/sessions/:id/members',
        async ({ params, body, status }) => {
          const result =
            'templateId' in body
              ? await handlers.session.inviteSessionMember({ sessionId: params.id, templateId: body.templateId })
              : await handlers.session.spawnSessionMember({ sessionId: params.id, ...body });
          return status(201, result);
        },
        {
          params: contracts.members.add.params,
          body: contracts.members.add.body,
          response: contracts.members.add.response,
          detail: {
            tags: ['http-only'],
            summary: 'Invite or spawn a session member',
            description:
              'Invites a member from the project memberTemplates ({templateId}), or spawns one ad hoc ({type, name, ...}).'
          }
        }
      )
      .delete(
        '/sessions/:id/members/:memberId',
        async ({ params }) => handlers.session.removeSessionMember({ sessionId: params.id, memberId: params.memberId }),
        {
          params: contracts.members.remove.params,
          response: contracts.members.remove.response,
          detail: {
            tags: ['http-only'],
            summary: 'Remove a session member',
            description: 'Stops the member’s runtime if running, then deletes its session binding.'
          }
        }
      )
      .get(
        '/sessions/:id/members/:memberId/ui-observation',
        async ({ params }) => handlers.session.observeMemberUi({ sessionId: params.id, memberId: params.memberId }),
        {
          params: sessionMemberParams,
          response: { 200: sessionMemberUiObservationFrameSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Read a session member’s neutral (projected) observation frame',
            description:
              'The `AgentObservationEvent` plane for a session member with no `externalAgentSessionId` of ' +
              'its own (today, the monad built-in agent) — the session-member counterpart to ' +
              'GET /external-agent-sessions/:id/ui-observation.'
          }
        }
      )
      .get(
        '/sessions/:id/members/:memberId/ui-observation-stream',
        ({ params }) => createSessionMemberUiObservationSseResponse(handlers, params.id, params.memberId, encoder),
        {
          params: sessionMemberParams,
          detail: {
            tags: ['http-only'],
            summary: 'Stream a session member’s neutral (projected) observation frames',
            description: 'The session-member counterpart to GET /external-agent-sessions/:id/ui-observation-stream.'
          }
        }
      )
      .post(
        '/sessions/:id/acp/:agent',
        async ({ params, body }) =>
          handlers.session.forwardToAcp({
            sessionId: params.id,
            agentName: params.agent,
            text: body.text,
            ambientContext: body.ambientContext
          }),
        {
          params: contracts.forwardToAcp.params,
          body: contracts.forwardToAcp.body,
          response: contracts.forwardToAcp.response,
          detail: {
            tags: ['http-only'],
            summary: 'Forward to ACP agent',
            description: 'Sends a message directly to a configured ACP agent, bypassing the Monad LLM layer.'
          }
        }
      )
      .get(
        '/sessions/:id/events',
        async ({ params, headers, query }) =>
          createSessionEventsSseResponse({
            handlers,
            sessionId: params.id,
            afterEventId: headers['last-event-id'] ?? query.after,
            encoder
          }),
        {
          params: sessionParams,
          query: z.object({ after: eventIdSchema.optional() }),
          headers: z.looseObject({ 'last-event-id': eventIdSchema.optional() }),
          response: { 200: responseInstanceSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Stream session events',
            description: 'Streams session events over Server-Sent Events with resume support.'
          }
        }
      )
      .get(
        '/sessions/:id/messages/:messageId/stream',
        async ({ params, headers, query }) =>
          createSessionMessageGenerationSseResponse({
            handlers,
            sessionId: params.id,
            messageId: params.messageId,
            afterEventId: headers['last-event-id'] ?? query.after,
            encoder
          }),
        {
          params: sessionMessageParams,
          query: z.object({ after: eventIdSchema.optional() }),
          headers: z.looseObject({ 'last-event-id': eventIdSchema.optional() }),
          response: { 200: responseInstanceSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Stream message generation',
            description: 'Streams one generated message snapshot, deltas, and terminal event over Server-Sent Events.'
          }
        }
      )
      .get(
        '/sessions/:id/logs',
        async ({ params }) => createSessionLogsSseResponse({ sessionId: params.id, encoder }),
        {
          params: sessionParams,
          response: { 200: responseInstanceSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Stream session developer logs',
            description: 'Streams live structured logger records for a session over Server-Sent Events.'
          }
        }
      )
      .get(
        '/sessions/:id/ui-stream',
        async ({ params, headers, query }) =>
          createSessionUiEventsSseResponse({
            handlers,
            sessionId: params.id,
            afterEventId: headers['last-event-id'] ?? query.after,
            encoder
          }),
        {
          params: sessionParams,
          query: z.object({ after: eventIdSchema.optional() }),
          headers: z.looseObject({ 'last-event-id': eventIdSchema.optional() }),
          response: { 200: responseInstanceSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Stream projected session UI events',
            description: 'Streams server-projected UI snapshot and incremental updates over Server-Sent Events.'
          }
        }
      )
  );
}
