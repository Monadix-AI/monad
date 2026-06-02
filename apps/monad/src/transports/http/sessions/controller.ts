import type { GenerateMessageResponse, ListMessagesResponse } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { IdempotencyStore } from '#/transports/http/idempotency.ts';

import {
  configureRuntimeRequestSchema,
  daemonHttpContract,
  eventCursorSchema,
  eventIdSchema,
  listUiItemsQuerySchema,
  listUiItemsResponseSchema,
  messageIdSchema,
  okResponseSchema,
  responseInstanceSchema,
  sessionIdSchema,
  workspaceActionRequestSchema,
  workspaceActionResponseSchema,
  workspaceGitSchema,
  workspaceMetaSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { buildOperationSource } from '#/handlers/session/origin.ts';
import { idempotentJsonHandler } from '#/transports/http/idempotency.ts';
import {
  createSessionEventsSseResponse,
  createSessionLogsSseResponse,
  createSessionMeshStateSseResponse,
  createSessionMessageGenerationSseResponse,
  createSessionMessageSseResponse,
  createSessionUiEventsSseResponse,
  wantsInlineSessionStream
} from '#/transports/http/sessions/stream.ts';
import { mapDirectPublicError, projectHttpError } from '#/transports/public-error.ts';

// The HTTP-only routes in this otherwise-universal controller (SSE events and out-of-band runtime
// config) declare their contracts inline from protocol leaf schemas — they have no
// JSON-RPC twin, so they don't belong in daemonHttpContract (which mirrors the universal METHOD_TABLE
// methods). MeshAgent observation instead lives under `/mesh/sessions/:id/*`.
const sessionParams = z.object({ id: sessionIdSchema });
const sessionMessageParams = sessionParams.extend({ messageId: messageIdSchema });

// A scope-bound stream resume cursor is either a bare event id (legacy Last-Event-ID) or an encoded
// `cur_` token carrying its plane + transcript scope. The subscribe handler resolves and scope-checks
// it; the endpoint only needs to admit both shapes instead of rejecting the token at validation.
const resumeCursorSchema = z.union([eventIdSchema, eventCursorSchema]);

export function createSessionsController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  encoder: TextEncoder,
  idempotencyStore: IdempotencyStore
) {
  const contracts = daemonHttpContract.sessions;
  type CreateSessionContext = {
    body: z.infer<typeof contracts.create.body>;
    request: Request;
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
      .get('/sessions/attention', async ({ query }) => handlers.session.listAttention(query), {
        query: contracts.attention.list.query,
        response: contracts.attention.list.response,
        detail: { summary: 'List session attention', description: 'Returns sidebar attention projections.' }
      })
      .post(
        '/sessions',
        idempotentJsonHandler<CreateSessionContext>({
          route: () => '/v1/sessions',
          store: idempotencyStore,
          handler: async ({ body }) => {
            // Identity (surface/client) is client-declared (a TUI sends surface:'tui'); transport and
            // env are filled server-side and never trusted from the body. env is audit-only.
            const origin = buildOperationSource({
              transport: 'http',
              surface: body.origin?.surface ?? 'web',
              client: body.origin?.client ?? 'monad-web',
              clientVersion: body.origin?.clientVersion
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
              const mapped = mapDirectPublicError(request, 412, 'PRECONDITION_FAILED', 'precondition failed', false);
              set.headers.etag = etag;
              set.headers['x-monad-request-id'] = mapped.descriptor.requestId;
              return status(412, projectHttpError(mapped.descriptor));
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
      .post(
        '/sessions/:id/attention/consume',
        async ({ params, body }) => handlers.session.consumeAttention({ id: params.id, ...body }),
        {
          params: contracts.attention.consume.params,
          body: contracts.attention.consume.body,
          response: contracts.attention.consume.response,
          detail: { summary: 'Consume session attention', description: 'Consumes exact unread item keys.' }
        }
      )
      .get('/sessions/:id/plan', async ({ params }) => handlers.session.listPlan({ id: params.id }), {
        params: contracts.plan.list.params,
        response: contracts.plan.list.response,
        detail: { summary: 'List session plan', description: 'Returns the durable todo plan for a session.' }
      })
      .post(
        '/sessions/:id/plan/todos',
        async ({ params, body }) => {
          const { origin: originHint, ...rest } = body;
          const origin = buildOperationSource({
            transport: 'http',
            surface: originHint?.surface ?? 'web',
            client: originHint?.client ?? 'monad-web',
            clientVersion: originHint?.clientVersion
          });
          return handlers.session.addPlanTodo({ id: params.id, origin, ...rest });
        },
        {
          params: contracts.plan.addTodo.params,
          body: contracts.plan.addTodo.body,
          response: contracts.plan.addTodo.response,
          detail: { summary: 'Add plan todo', description: 'Adds a todo to the session plan.' }
        }
      )
      .patch(
        '/sessions/:id/plan/todos/:todoId',
        async ({ params, body }) => {
          const { origin: originHint, ...rest } = body;
          const origin = buildOperationSource({
            transport: 'http',
            surface: originHint?.surface ?? 'web',
            client: originHint?.client ?? 'monad-web',
            clientVersion: originHint?.clientVersion
          });
          return handlers.session.updatePlanTodo({ id: params.id, todoId: params.todoId, origin, ...rest });
        },
        {
          params: contracts.plan.updateTodo.params,
          body: contracts.plan.updateTodo.body,
          response: contracts.plan.updateTodo.response,
          detail: { summary: 'Update plan todo', description: 'Applies a CAS-guarded patch to a plan todo.' }
        }
      )
      .delete(
        '/sessions/:id/plan/todos/:todoId',
        async ({ params, body }) => {
          const { origin: originHint, ...rest } = body;
          const origin = buildOperationSource({
            transport: 'http',
            surface: originHint?.surface ?? 'web',
            client: originHint?.client ?? 'monad-web',
            clientVersion: originHint?.clientVersion
          });
          return handlers.session.deletePlanTodo({ id: params.id, todoId: params.todoId, origin, ...rest });
        },
        {
          params: contracts.plan.deleteTodo.params,
          body: contracts.plan.deleteTodo.body,
          response: contracts.plan.deleteTodo.response,
          detail: { summary: 'Delete plan todo', description: 'Removes a todo from the session plan (CAS-guarded).' }
        }
      )
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
        async ({ params, body, status }) => {
          // The child's origin is stamped from THIS (branching) transport, not the parent's.
          const origin = buildOperationSource({
            transport: 'http',
            surface: body.origin?.surface ?? 'web',
            client: body.origin?.client ?? 'monad-web',
            clientVersion: body.origin?.clientVersion
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
      .post(
        '/sessions/:id/ui-messages/resolve',
        async ({ params, body }) => handlers.session.resolveUiMessages({ id: params.id, messageIds: body.messageIds }),
        {
          params: contracts.resolveUiMessages.params,
          body: contracts.resolveUiMessages.body,
          response: contracts.resolveUiMessages.response,
          detail: {
            summary: 'Resolve session UI messages',
            description: 'Resolves a bounded batch of active session messages for lookup-only UI references.'
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
          if (
            body.steer ||
            (body.continueFromHistory && body.replyToMessageId !== undefined) ||
            !wantsInlineSessionStream(headers.accept) ||
            body.generate === false
          ) {
            return idempotentJsonHandler({
              route: () => `/v1/sessions/${params.id}/messages`,
              store: idempotencyStore,
              handler: async () =>
                Response.json(
                  await handlers.session.send({
                    sessionId: params.id,
                    text: body.text,
                    attachments: body.attachments,
                    generate: body.generate,
                    steer: body.steer,
                    steerMessages: body.steerMessages,
                    continueFromHistory: body.continueFromHistory,
                    ambientContext: body.ambientContext,
                    replyToMessageId: body.replyToMessageId
                  })
                )
            })({ body, request });
          }

          return createSessionMessageSseResponse({
            handlers,
            sessionId: params.id,
            text: body.text,
            attachments: body.attachments,
            continueFromHistory: body.continueFromHistory,
            ambientContext: body.ambientContext,
            replyToMessageId: body.replyToMessageId,
            signal: request.signal,
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
          handlers.session.generate({
            sessionId: params.id,
            text: body.text,
            steer: body.steer,
            continueFromHistory: body.continueFromHistory,
            replyToMessageId: body.replyToMessageId
          }),
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
      .get(
        '/sessions/:id/project-roster',
        async ({ params }) => handlers.session.listProjectRoster({ sessionId: params.id }),
        {
          params: contracts.members.projectRoster.params,
          response: contracts.members.projectRoster.response,
          detail: {
            tags: ['http-only'],
            summary: 'List every project member',
            description:
              "Returns every ProjectMember of the session's project, including ones not currently bound into this session."
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
      .put(
        '/sessions/:id/members/:memberId',
        async ({ params }) =>
          handlers.session.bindSessionMember({ sessionId: params.id, projectMemberId: params.memberId }),
        {
          params: contracts.members.bind.params,
          response: contracts.members.bind.response,
          detail: {
            tags: ['http-only'],
            summary: 'Bind a project member to a session',
            description:
              'Binds an existing project member into this session and returns the joined identity and binding. Idempotent.'
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
          // Cursor semantics stay in resolveReplayCursor so malformed tokens project as
          // CURSOR_INVALID instead of Elysia's generic VALIDATION response.
          query: z.object({ after: resumeCursorSchema.optional() }),
          headers: z.looseObject({ 'last-event-id': resumeCursorSchema.optional() }),
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
          // Cursor semantics stay in resolveReplayCursor so malformed tokens project as
          // CURSOR_INVALID instead of Elysia's generic VALIDATION response.
          query: z.object({ after: resumeCursorSchema.optional() }),
          headers: z.looseObject({ 'last-event-id': resumeCursorSchema.optional() }),
          response: { 200: responseInstanceSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Stream projected session UI events',
            description: 'Streams server-projected UI snapshot and incremental updates over Server-Sent Events.'
          }
        }
      )
      .get(
        '/sessions/:id/mesh-state/stream',
        async ({ params, headers, query }) =>
          createSessionMeshStateSseResponse({
            handlers,
            sessionId: params.id,
            afterEventId: headers['last-event-id'] ?? query.after,
            encoder
          }),
        {
          params: sessionParams,
          // Canonical event-id resume only: this plane is owned by mesh state, not the scope-bound
          // opaque cursor used by /events and /ui-stream, so eventCursorSchema is intentionally excluded.
          query: z.object({ after: eventIdSchema.optional() }),
          headers: z.looseObject({ 'last-event-id': eventIdSchema.optional() }),
          response: { 200: responseInstanceSchema },
          detail: {
            tags: ['http-only'],
            summary: 'Stream neutral mesh agent session state',
            description: 'Streams a neutral MeshAgent state snapshot and canonical mesh events over Server-Sent Events.'
          }
        }
      )
  );
}
