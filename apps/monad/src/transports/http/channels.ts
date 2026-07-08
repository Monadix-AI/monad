import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import {
  abortSessionResponseSchema,
  daemonHttpContract,
  eventIdSchema,
  httpErrorSchema,
  listMessagesQuerySchema,
  listMessagesResponseSchema,
  listUiItemsQuerySchema,
  listUiItemsResponseSchema,
  projectIdSchema,
  resetSessionResponseSchema,
  responseInstanceSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  sessionIdSchema,
  workspaceActionRequestSchema,
  workspaceActionResponseSchema,
  workspaceMetaSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { buildSessionOrigin } from '@/handlers/session/origin.ts';
import { createSessionEventsSseResponse, createSessionUiEventsSseResponse } from '@/transports/http/sessions/stream.ts';

const projectParams = z.object({ id: projectIdSchema });
const channelParams = z.object({ id: sessionIdSchema });

export function createChannelsController(handlers: ReturnType<typeof createDaemonHandlers>, encoder: TextEncoder) {
  const contracts = daemonHttpContract.workplace.projects;
  return new Elysia({ tags: ['http-only'] })
    .get('/workplace/projects', async ({ query }) => handlers.session.listProjects(query), {
      query: contracts.list.query,
      response: contracts.list.response,
      detail: {
        summary: 'List workplace projects',
        description: 'Returns Workplace Projects, separate from Monad agent sessions.'
      }
    })
    .post(
      '/workplace/projects',
      async ({ body, status, set }) => {
        const origin = buildSessionOrigin({
          transport: 'http',
          surface: body.origin?.surface ?? 'web',
          client: 'workplace',
          clientVersion: body.origin?.clientVersion,
          ext: body.origin?.ext
        });
        const result = await handlers.session.createProject({
          title: body.title,
          origin,
          cwd: body.cwd
        });
        set.headers.location = `/v1/workplace/projects/${result.projectId}`;
        return status(201, result);
      },
      {
        body: contracts.create.body,
        response: contracts.create.response,
        detail: {
          summary: 'Create workplace project',
          description: 'Creates a Workplace Project without creating a Monad agent session.'
        }
      }
    )
    .get(
      '/workplace/projects/:id',
      async ({ params, set }) => {
        const result = await handlers.session.getProject({ id: params.id });
        set.headers.etag = `"${result.project.updatedAt}"`;
        return result;
      },
      {
        params: contracts.get.params,
        response: contracts.get.response,
        detail: { summary: 'Get workplace project', description: 'Returns one Workplace Project by id.' }
      }
    )
    .patch(
      '/workplace/projects/:id',
      async ({ params, body, request, set, status }) => {
        const ifMatch = request.headers.get('if-match');
        if (ifMatch && ifMatch !== '*') {
          const current = await handlers.session.getProject({ id: params.id });
          const etag = `"${current.project.updatedAt}"`;
          if (ifMatch !== etag) {
            set.headers.etag = etag;
            return status(412, { error: 'precondition failed', code: 'PRECONDITION_FAILED' });
          }
        }
        const result = await handlers.session.updateProject({ id: params.id, ...body });
        set.headers.etag = `"${result.project.updatedAt}"`;
        return result;
      },
      {
        params: contracts.update.params,
        body: contracts.update.body,
        response: contracts.update.response,
        detail: { summary: 'Update workplace project', description: 'Updates a Workplace Project.' }
      }
    )
    .delete('/workplace/projects/:id', async ({ params }) => handlers.session.deleteProject({ id: params.id }), {
      params: contracts.delete.params,
      response: contracts.delete.response,
      detail: { summary: 'Delete workplace project', description: 'Deletes the project and associated data.' }
    })
    .get(
      '/projects/:id/sessions',
      async ({ params }) => handlers.session.listProjectSessions({ projectId: params.id }),
      {
        params: contracts.sessions.list.params,
        response: contracts.sessions.list.response,
        detail: {
          summary: 'List project sessions',
          description: 'Lists the sessions under a Workplace Project (Track B).'
        }
      }
    )
    .post(
      '/projects/:id/sessions',
      async ({ params, body, status, set }) => {
        const origin = buildSessionOrigin({
          transport: 'http',
          surface: body.origin?.surface ?? 'web',
          client: 'workplace',
          clientVersion: body.origin?.clientVersion,
          ext: body.origin?.ext
        });
        const result = await handlers.session.createProjectSession({
          projectId: params.id,
          title: body.title,
          origin,
          cwd: body.cwd
        });
        set.headers.location = `/v1/sessions/${result.sessionId}`;
        return status(201, result);
      },
      {
        params: contracts.sessions.create.params,
        body: contracts.sessions.create.body,
        response: contracts.sessions.create.response,
        detail: {
          summary: 'Create project session',
          description: 'Creates a new session under a Workplace Project (Track B). No default session is auto-created.'
        }
      }
    )
    .get(
      '/projects/:id/messages',
      async ({ params, query }) =>
        handlers.session.messages({
          id: params.id,
          limit: query.limit,
          before: query.before,
          includeInactive: query.includeInactive,
          includeAncestors: query.includeAncestors
        }),
      {
        params: projectParams,
        query: listMessagesQuerySchema,
        response: { 200: listMessagesResponseSchema, 404: httpErrorSchema },
        detail: {
          summary: 'List project messages',
          description: 'Returns Workplace Project transcript messages.'
        }
      }
    )
    .get(
      '/projects/:id/ui-items',
      async ({ params, query }) =>
        handlers.session.uiItems({
          id: params.id,
          limit: query.limit,
          before: query.before,
          after: query.after,
          around: query.around,
          includeInactive: query.includeInactive,
          includeAncestors: query.includeAncestors
        }),
      {
        params: projectParams,
        query: listUiItemsQuerySchema,
        response: { 200: listUiItemsResponseSchema, 404: httpErrorSchema },
        detail: {
          summary: 'List projected project UI items',
          description: 'Returns server-projected transcript and tool timeline items for the Workplace Project.'
        }
      }
    )
    .post(
      '/projects/:id/messages',
      async ({ params, body }) =>
        handlers.session.sendProjectMessage({ sessionId: params.id, text: body.text, attachments: body.attachments }),
      {
        params: projectParams,
        body: sendMessageRequestSchema.pick({ attachments: true, text: true }),
        response: { 200: sendMessageResponseSchema, 404: httpErrorSchema },
        detail: {
          summary: 'Send project message',
          description: 'Routes a workplace project message according to the project host and mention rules.'
        }
      }
    )
    .post('/projects/:id/reset', async ({ params }) => handlers.session.reset({ id: params.id }), {
      params: projectParams,
      response: { 200: resetSessionResponseSchema, 404: httpErrorSchema },
      detail: {
        summary: 'Reset project transcript',
        description: 'Clears all messages and events from a Workplace Project, keeping the project itself.'
      }
    })
    .post('/projects/:id/abort', async ({ params }) => handlers.session.abort({ id: params.id }), {
      params: projectParams,
      response: { 200: abortSessionResponseSchema, 404: httpErrorSchema },
      detail: {
        summary: 'Abort project generation',
        description: 'Aborts the active turn for a Workplace Project.'
      }
    })
    .get('/projects/:id/workspace-meta', async ({ params }) => handlers.session.workspaceMeta({ id: params.id }), {
      params: projectParams,
      response: { 200: workspaceMetaSchema, 404: httpErrorSchema },
      detail: {
        summary: 'Workspace metadata for the project working folder',
        description: 'Returns best-effort metadata slices for the Workplace Project working folder.'
      }
    })
    .post(
      '/projects/:id/workspace-action',
      async ({ params, body }) => handlers.session.workspaceAction({ id: params.id, action: body.action }),
      {
        params: projectParams,
        body: workspaceActionRequestSchema,
        response: { 200: workspaceActionResponseSchema, 404: httpErrorSchema },
        detail: {
          summary: 'Open the project working folder on the daemon host',
          description: 'Runs a platform-native file manager or terminal action for the project working folder.'
        }
      }
    )
    .get(
      '/projects/:id/events',
      async ({ params, headers, query }) =>
        createSessionEventsSseResponse({
          handlers,
          sessionId: params.id,
          afterEventId: headers['last-event-id'] ?? query.after,
          encoder
        }),
      {
        params: projectParams,
        query: z.object({ after: eventIdSchema.optional() }),
        headers: z.looseObject({ 'last-event-id': eventIdSchema.optional() }),
        response: { 200: responseInstanceSchema },
        detail: {
          summary: 'Stream project events',
          description: 'Streams Workplace Project events over Server-Sent Events with resume support.'
        }
      }
    )
    .get(
      '/projects/:id/ui-stream',
      async ({ params, headers, query }) =>
        createSessionUiEventsSseResponse({
          handlers,
          sessionId: params.id,
          afterEventId: headers['last-event-id'] ?? query.after,
          encoder
        }),
      {
        params: projectParams,
        query: z.object({ after: eventIdSchema.optional() }),
        headers: z.looseObject({ 'last-event-id': eventIdSchema.optional() }),
        response: { 200: responseInstanceSchema },
        detail: {
          summary: 'Stream projected project UI events',
          description: 'Streams server-projected Workplace Project UI snapshots and incremental updates.'
        }
      }
    )
    .post(
      '/channels/:id/messages',
      async ({ params, body }) =>
        handlers.session.sendChannelMessage({ sessionId: params.id, text: body.text, attachments: body.attachments }),
      {
        params: channelParams,
        body: sendMessageRequestSchema.pick({ attachments: true, text: true }),
        response: { 200: sendMessageResponseSchema, 404: httpErrorSchema },
        detail: {
          summary: 'Send legacy channel message',
          description: 'Compatibility alias for project message routing.'
        }
      }
    );
}
