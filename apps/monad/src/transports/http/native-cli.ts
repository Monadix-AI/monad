import type { NativeCliAuthSessionView, NativeCliObservationAccessResponse } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  getNativeAgentDeliveryResponseSchema,
  getNativeCliAuthSessionResponseSchema,
  getNativeCliSessionResponseSchema,
  listNativeCliSessionsResponseSchema,
  nativeAgentDeliveryIdSchema,
  nativeCliApprovalResolutionRequestSchema,
  nativeCliAuthStatusResponseSchema,
  nativeCliHistoryPageRequestSchema,
  nativeCliHistoryPageResponseSchema,
  nativeCliInputRequestSchema,
  nativeCliObservationAccessResponseSchema,
  nativeCliResizeRequestSchema,
  nativeCliUsageResponseSchema,
  okResponseSchema,
  startNativeCliAgentRequestSchema,
  startNativeCliAgentResponseSchema,
  startNativeCliAuthResponseSchema,
  transcriptTargetIdSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { createPushSseResponse, encodeSseFrame } from '@/transports/http/sessions/sse.ts';

const sessionParams = z.object({ id: z.string() });
const nativeCliParams = z.object({ id: z.string() });
const nativeAgentDeliveryParams = z.object({ id: nativeAgentDeliveryIdSchema });
const nativeCliAgentParams = z.object({ name: z.string().min(1) });
const nativeCliScopeQuery = z.object({ transcriptTargetId: transcriptTargetIdSchema });
const nativeCliAuthScopeQuery = z.object({ controlToken: z.string().min(32) });

function createNativeCliAuthEventsSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  controlToken: string,
  encoder: TextEncoder
): Response {
  return createPushSseResponse<NativeCliAuthSessionView>({
    encoder,
    encode: (session) => encodeSseFrame({ event: 'native_cli.auth', data: session }, encoder),
    subscribe: (emit) => {
      const subscription = handlers.nativeCli.subscribeAuth({
        id,
        controlToken,
        onSession: (session) => emit(session)
      });
      emit(subscription.session);
      return { dispose: subscription.dispose };
    }
  });
}

function createNativeCliObservationSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  transcriptTargetId: `ses_${string}` | `prj_${string}`,
  encoder: TextEncoder
): Response {
  return createPushSseResponse<NativeCliObservationAccessResponse>({
    encoder,
    encode: (access) => encodeSseFrame({ event: 'native_cli.observation', data: access }, encoder),
    subscribe: (emit) => {
      let disposed = false;
      let disposeLive = (): void => {};
      void handlers.nativeCli
        .observe({ id, transcriptTargetId })
        .then((initial) => {
          if (disposed) return;
          if (initial.state !== 'live') {
            emit(initial, true);
            return;
          }
          const subscription = handlers.nativeCli.subscribeObservation({
            id,
            transcriptTargetId,
            onObservation: (access, done) => emit(access, done)
          });
          disposeLive = subscription.dispose;
          emit(subscription.access, !subscription.live);
        })
        .catch(() => {
          if (!disposed) {
            emit({ state: 'unavailable', nativeCliSessionId: id, reason: 'provider history unavailable' }, true);
          }
        });
      return {
        dispose: () => {
          disposed = true;
          disposeLive();
        }
      };
    }
  });
}

export function createNativeCliController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const encoder = new TextEncoder();
  return new Elysia()
    .post(
      '/sessions/:id/native-cli-agents/start',
      async ({ params, body }) => handlers.nativeCli.start({ sessionId: params.id as `ses_${string}`, request: body }),
      {
        params: sessionParams,
        body: startNativeCliAgentRequestSchema,
        response: { 200: startNativeCliAgentResponseSchema },
        detail: { summary: 'Start a native CLI agent in a project' }
      }
    )
    .get(
      '/sessions/:id/native-cli-sessions',
      ({ params }) => handlers.nativeCli.list({ sessionId: params.id as `ses_${string}` }),
      {
        params: sessionParams,
        response: { 200: listNativeCliSessionsResponseSchema },
        detail: { summary: 'List native CLI sessions for a project' }
      }
    )
    .get(
      '/projects/:id/native-cli-sessions',
      ({ params }) => handlers.nativeCli.list({ sessionId: params.id as `prj_${string}` }),
      {
        params: sessionParams,
        response: { 200: listNativeCliSessionsResponseSchema },
        detail: { summary: 'List native CLI sessions for a Workplace Project', tags: ['http-only'] }
      }
    )
    .get('/native-cli-sessions/:id', ({ params, query }) => handlers.nativeCli.get({ id: params.id, ...query }), {
      params: nativeCliParams,
      query: nativeCliScopeQuery,
      response: { 200: getNativeCliSessionResponseSchema },
      detail: { summary: 'Get a native CLI session snapshot' }
    })
    .get(
      '/native-cli-sessions/:id/observation',
      async ({ params, query }) => handlers.nativeCli.observe({ id: params.id, ...query }),
      {
        params: nativeCliParams,
        query: nativeCliScopeQuery,
        response: { 200: nativeCliObservationAccessResponseSchema },
        detail: { summary: 'Read live or backfilled native CLI observation access', tags: ['http-only'] }
      }
    )
    .get(
      '/native-cli-sessions/:id/observation-stream',
      ({ params, query }) =>
        createNativeCliObservationSseResponse(handlers, params.id, query.transcriptTargetId, encoder),
      {
        params: nativeCliParams,
        query: nativeCliScopeQuery,
        detail: { summary: 'Stream live or backfilled native CLI observation access', tags: ['http-only'] }
      }
    )
    .get(
      '/native-agent-deliveries/:id',
      ({ params, query }) => handlers.nativeCli.delivery({ id: params.id, ...query }),
      {
        params: nativeAgentDeliveryParams,
        query: nativeCliScopeQuery,
        response: { 200: getNativeAgentDeliveryResponseSchema },
        detail: { summary: 'Read managed native CLI delivery pointer state', tags: ['http-only'] }
      }
    )
    .get(
      '/native-agent-deliveries/:id/observation',
      ({ params, query }) => handlers.nativeCli.observeDelivery({ id: params.id, ...query }),
      {
        params: nativeAgentDeliveryParams,
        query: nativeCliScopeQuery,
        response: { 200: nativeCliObservationAccessResponseSchema },
        detail: { summary: 'Read native CLI observation through a delivery pointer', tags: ['http-only'] }
      }
    )
    .post(
      '/native-cli-sessions/:id/input',
      ({ params, query, body }) => handlers.nativeCli.input({ id: params.id, ...query, ...body }),
      {
        params: nativeCliParams,
        query: nativeCliScopeQuery,
        body: nativeCliInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to a native CLI session' }
      }
    )
    .post(
      '/native-cli-sessions/:id/approval',
      ({ params, query, body }) => handlers.nativeCli.approval({ id: params.id, ...query, ...body }),
      {
        params: nativeCliParams,
        query: nativeCliScopeQuery,
        body: nativeCliApprovalResolutionRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resolve a provider-owned native CLI approval request' }
      }
    )
    .post(
      '/native-cli-sessions/:id/resize',
      ({ params, query, body }) => handlers.nativeCli.resize({ id: params.id, ...query, ...body }),
      {
        params: nativeCliParams,
        query: nativeCliScopeQuery,
        body: nativeCliResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize a native CLI PTY' }
      }
    )
    .post(
      '/native-cli-sessions/:id/stop',
      ({ params, query }) => handlers.nativeCli.stop({ id: params.id, ...query }),
      {
        params: nativeCliParams,
        query: nativeCliScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Stop a native CLI session' }
      }
    )
    .post(
      '/native-cli-sessions/:id/history-page',
      ({ params, query, body }) => handlers.nativeCli.historyPage({ id: params.id, ...query, request: body }),
      {
        params: nativeCliParams,
        query: nativeCliScopeQuery,
        body: nativeCliHistoryPageRequestSchema,
        response: { 200: nativeCliHistoryPageResponseSchema },
        detail: { summary: 'Load a paged native CLI provider history page' }
      }
    )
    .post(
      '/native-cli-agents/:name/auth/start',
      ({ params }) => handlers.nativeCli.startAuth({ agentName: params.name }),
      {
        params: nativeCliAgentParams,
        response: { 200: startNativeCliAuthResponseSchema },
        detail: { summary: 'Start a provider-owned native CLI login flow' }
      }
    )
    .get(
      '/native-cli-agents/:name/auth/status',
      ({ params }) => handlers.nativeCli.authStatus({ agentName: params.name }),
      {
        params: nativeCliAgentParams,
        response: { 200: nativeCliAuthStatusResponseSchema },
        detail: { summary: 'Check provider-owned native CLI login status' }
      }
    )
    .get('/native-cli-agents/:name/usage', ({ params }) => handlers.nativeCli.usage({ agentName: params.name }), {
      params: nativeCliAgentParams,
      response: { 200: nativeCliUsageResponseSchema },
      detail: { summary: 'Read provider-owned native CLI usage records' }
    })
    .get(
      '/native-cli-auth-sessions/:id',
      ({ params, query }) => handlers.nativeCli.getAuth({ id: params.id, ...query }),
      {
        params: nativeCliParams,
        query: nativeCliAuthScopeQuery,
        response: { 200: getNativeCliAuthSessionResponseSchema },
        detail: { summary: 'Get a native CLI auth session snapshot' }
      }
    )
    .get(
      '/native-cli-auth-sessions/:id/events',
      ({ params, query }) => createNativeCliAuthEventsSseResponse(handlers, params.id, query.controlToken, encoder),
      {
        params: nativeCliParams,
        query: nativeCliAuthScopeQuery,
        detail: { summary: 'Stream native CLI auth session snapshots', tags: ['http-only'] }
      }
    )
    .post(
      '/native-cli-auth-sessions/:id/input',
      ({ params, query, body }) => handlers.nativeCli.inputAuth({ id: params.id, ...query, ...body }),
      {
        params: nativeCliParams,
        query: nativeCliAuthScopeQuery,
        body: nativeCliInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to a native CLI auth session' }
      }
    )
    .post(
      '/native-cli-auth-sessions/:id/resize',
      ({ params, query, body }) => handlers.nativeCli.resizeAuth({ id: params.id, ...query, ...body }),
      {
        params: nativeCliParams,
        query: nativeCliAuthScopeQuery,
        body: nativeCliResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize a native CLI auth PTY' }
      }
    )
    .post(
      '/native-cli-auth-sessions/:id/heartbeat',
      ({ params, query }) => handlers.nativeCli.heartbeatAuth({ id: params.id, ...query }),
      {
        params: nativeCliParams,
        query: nativeCliAuthScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Keep a native CLI auth PTY attached to a live browser surface', tags: ['http-only'] }
      }
    )
    .post(
      '/native-cli-auth-sessions/:id/stop',
      ({ params, query }) => handlers.nativeCli.stopAuth({ id: params.id, ...query }),
      {
        params: nativeCliParams,
        query: nativeCliAuthScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Stop a native CLI auth session' }
      }
    );
}
