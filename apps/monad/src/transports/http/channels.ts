import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { IdempotencyStore } from '#/transports/http/idempotency.ts';

import {
  daemonHttpContract,
  httpErrorSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  sessionIdSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { buildSessionOrigin } from '#/handlers/session/origin.ts';
import { idempotentJsonHandler } from '#/transports/http/idempotency.ts';

const channelParams = z.object({ id: sessionIdSchema });

export function createChannelsController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  idempotencyStore: IdempotencyStore
) {
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
      idempotentJsonHandler({
        route: () => '/v1/workplace/projects',
        store: idempotencyStore,
        handler: async ({ body }) => {
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
          return Response.json(result, {
            headers: { location: `/v1/workplace/projects/${result.projectId}` },
            status: 201
          });
        }
      }),
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
      async ({ params, query }) =>
        handlers.session.listProjectSessions({ projectId: params.id, limit: query.limit, offset: query.offset }),
      {
        params: contracts.sessions.list.params,
        query: contracts.sessions.list.query,
        response: contracts.sessions.list.response,
        detail: {
          summary: 'List project sessions',
          description: 'Lists the sessions under a Workplace Project (Track B).'
        }
      }
    )
    .post(
      '/projects/:id/sessions',
      idempotentJsonHandler({
        route: ({ params }) => `/v1/projects/${params.id}/sessions`,
        store: idempotencyStore,
        handler: async ({ params, body }) => {
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
          return Response.json(result, {
            headers: { location: `/v1/sessions/${result.sessionId}` },
            status: 201
          });
        }
      }),
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
    .post(
      '/channels/:id/messages',
      idempotentJsonHandler({
        route: ({ params }) => `/v1/channels/${params.id}/messages`,
        store: idempotencyStore,
        handler: async ({ params, body }) =>
          Response.json(
            await handlers.session.sendChannelMessage({
              sessionId: params.id,
              text: body.text,
              attachments: body.attachments
            })
          )
      }),
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
