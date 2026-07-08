import type {
  ExternalAgentAuthSessionView,
  ExternalAgentSessionId,
  ExternalAgentUiObservationFrame
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  externalAgentApprovalResolutionRequestSchema,
  externalAgentAuthStatusResponseSchema,
  externalAgentHistoryPageRequestSchema,
  externalAgentHistoryPageResponseSchema,
  externalAgentInputRequestSchema,
  externalAgentObservationAccessResponseSchema,
  externalAgentResizeRequestSchema,
  externalAgentUiObservationFrameSchema,
  externalAgentUsageResponseSchema,
  getExternalAgentAuthSessionResponseSchema,
  getExternalAgentSessionResponseSchema,
  getNativeAgentDeliveryResponseSchema,
  listExternalAgentRuntimesQuerySchema,
  listExternalAgentRuntimesResponseSchema,
  listExternalAgentSessionsResponseSchema,
  nativeAgentDeliveryIdSchema,
  okResponseSchema,
  sessionIdSchema,
  startExternalAgentAuthResponseSchema,
  startExternalAgentRequestSchema,
  startExternalAgentResponseSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { createPushSseResponse, encodeSseFrame } from '#/transports/http/sessions/sse.ts';

const sessionParams = z.object({ id: z.string() });
const externalAgentParams = z.object({ id: z.string() });
const nativeAgentDeliveryParams = z.object({ id: nativeAgentDeliveryIdSchema });
const externalAgentNameParams = z.object({ name: z.string().min(1) });
const externalAgentScopeQuery = z.object({ transcriptTargetId: sessionIdSchema });
const externalAgentHistoryPageQuery = externalAgentScopeQuery.merge(externalAgentHistoryPageRequestSchema);
const externalAgentAuthScopeQuery = z.object({ controlToken: z.string().min(32) });

function createExternalAgentAuthEventsSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  controlToken: string,
  encoder: TextEncoder
): Response {
  return createPushSseResponse<ExternalAgentAuthSessionView>({
    encoder,
    encode: (session) => encodeSseFrame({ event: 'external_agent.auth', data: session }, encoder),
    subscribe: (emit) => {
      const subscription = handlers.externalAgent.subscribeAuth({
        id,
        controlToken,
        onSession: (session) => emit(session)
      });
      emit(subscription.session);
      return { dispose: subscription.dispose };
    }
  });
}

// The neutral UI plane. Each frame carries the full projected event list (re-derived server-side from
// the whole snapshot), so unlike the raw stream there is no delta to resume — a reconnect just gets the
// next full frame. `seq` still tags each frame with the raw output cursor for cross-plane alignment.
function createExternalAgentUiObservationSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  transcriptTargetId: `ses_${string}`,
  encoder: TextEncoder
): Response {
  return createPushSseResponse<ExternalAgentUiObservationFrame>({
    encoder,
    encode: (frame) =>
      encodeSseFrame(
        {
          id: frame.state === 'live' && frame.seq !== undefined ? String(frame.seq) : undefined,
          event: 'external_agent.ui_observation',
          data: frame
        },
        encoder
      ),
    subscribe: (emit) => {
      let disposed = false;
      let disposeLive = (): void => {};
      void handlers.externalAgent
        .observeUi({ id, transcriptTargetId })
        .then((initial) => {
          if (disposed) return;
          if (initial.state !== 'live') {
            emit(initial, true);
            return;
          }
          const subscription = handlers.externalAgent.subscribeUiObservation({
            id,
            transcriptTargetId,
            onFrame: (frame, done) => emit(frame, done)
          });
          disposeLive = subscription.dispose;
          emit(subscription.frame, !subscription.live);
        })
        .catch(() => {
          if (!disposed) {
            emit(
              {
                state: 'unavailable',
                externalAgentSessionId: id as ExternalAgentSessionId,
                reason: 'provider history unavailable'
              },
              true
            );
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

export function createExternalAgentController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const encoder = new TextEncoder();
  return new Elysia()
    .post(
      '/sessions/:id/external-agents/start',
      async ({ params, body }) =>
        handlers.externalAgent.start({ sessionId: params.id as `ses_${string}`, request: body }),
      {
        params: sessionParams,
        body: startExternalAgentRequestSchema,
        response: { 200: startExternalAgentResponseSchema },
        detail: { summary: 'Start an external agent in a project' }
      }
    )
    .get(
      '/sessions/:id/external-agent-sessions',
      ({ params }) => handlers.externalAgent.list({ sessionId: params.id as `ses_${string}` }),
      {
        params: sessionParams,
        response: { 200: listExternalAgentSessionsResponseSchema },
        detail: { summary: 'List external agent sessions for a project' }
      }
    )
    .get('/external-agent-runtimes', ({ query }) => handlers.externalAgent.listLive(query), {
      query: listExternalAgentRuntimesQuerySchema,
      response: { 200: listExternalAgentRuntimesResponseSchema },
      detail: { summary: 'List all live external agent/agent-adapter runtimes daemon-wide', tags: ['http-only'] }
    })
    .get('/external-agent-session-summaries', ({ query }) => handlers.externalAgent.listAllSummaries(query), {
      query: listExternalAgentRuntimesQuerySchema,
      response: { 200: listExternalAgentRuntimesResponseSchema },
      detail: { summary: 'List external agent session summaries daemon-wide', tags: ['http-only'] }
    })
    .get(
      '/external-agent-sessions/:id',
      ({ params, query }) => handlers.externalAgent.get({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        response: { 200: getExternalAgentSessionResponseSchema },
        detail: { summary: 'Get an external agent session snapshot' }
      }
    )
    .get(
      '/external-agent-sessions/:id/observation',
      async ({ params, query }) => handlers.externalAgent.observe({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        response: { 200: externalAgentObservationAccessResponseSchema },
        detail: { summary: 'Read live or backfilled external agent observation access', tags: ['http-only'] }
      }
    )
    .get(
      '/external-agent-sessions/:id/ui-observation',
      async ({ params, query }) => handlers.externalAgent.observeUi({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        response: { 200: externalAgentUiObservationFrameSchema },
        detail: { summary: 'Read the neutral (projected) external agent observation frame', tags: ['http-only'] }
      }
    )
    .get(
      '/external-agent-sessions/:id/ui-observation-stream',
      ({ params, query }) =>
        createExternalAgentUiObservationSseResponse(handlers, params.id, query.transcriptTargetId, encoder),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        detail: { summary: 'Stream neutral (projected) external agent observation frames', tags: ['http-only'] }
      }
    )
    .get(
      '/native-agent-deliveries/:id',
      ({ params, query }) => handlers.externalAgent.delivery({ id: params.id, ...query }),
      {
        params: nativeAgentDeliveryParams,
        query: externalAgentScopeQuery,
        response: { 200: getNativeAgentDeliveryResponseSchema },
        detail: { summary: 'Read managed external agent delivery pointer state', tags: ['http-only'] }
      }
    )
    .get(
      '/native-agent-deliveries/:id/observation',
      ({ params, query }) => handlers.externalAgent.observeDelivery({ id: params.id, ...query }),
      {
        params: nativeAgentDeliveryParams,
        query: externalAgentScopeQuery,
        response: { 200: externalAgentObservationAccessResponseSchema },
        detail: { summary: 'Read external agent observation through a delivery pointer', tags: ['http-only'] }
      }
    )
    .post(
      '/external-agent-sessions/:id/input',
      ({ params, query, body }) => handlers.externalAgent.input({ id: params.id, ...query, ...body }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        body: externalAgentInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to an external agent session' }
      }
    )
    .post(
      '/external-agent-sessions/:id/interrupt',
      ({ params, query }) => handlers.externalAgent.interrupt({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Cancel the in-flight turn of an external agent session' }
      }
    )
    .post(
      '/external-agent-sessions/:id/steer',
      ({ params, query, body }) => handlers.externalAgent.steer({ id: params.id, ...query, ...body }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        body: externalAgentInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Inject input into the in-flight turn of an external agent session' }
      }
    )
    .post(
      '/external-agent-sessions/:id/approval',
      ({ params, query, body }) => handlers.externalAgent.approval({ id: params.id, ...query, ...body }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        body: externalAgentApprovalResolutionRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resolve a provider-owned external agent approval request' }
      }
    )
    .post(
      '/external-agent-sessions/:id/resize',
      ({ params, query, body }) => handlers.externalAgent.resize({ id: params.id, ...query, ...body }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        body: externalAgentResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize an external agent PTY' }
      }
    )
    .post(
      '/external-agent-sessions/:id/stop',
      ({ params, query }) => handlers.externalAgent.stop({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Stop an external agent session' }
      }
    )
    .get(
      '/external-agent-sessions/:id/history-page',
      ({ params, query }) => {
        const { transcriptTargetId, ...request } = query;
        return handlers.externalAgent.historyPage({ id: params.id, transcriptTargetId, request });
      },
      {
        params: externalAgentParams,
        query: externalAgentHistoryPageQuery,
        response: { 200: externalAgentHistoryPageResponseSchema },
        detail: { summary: 'Load a paged external agent provider history page' }
      }
    )
    .post(
      '/external-agents/:name/auth/start',
      ({ params }) => handlers.externalAgent.startAuth({ agentName: params.name }),
      {
        params: externalAgentNameParams,
        response: { 200: startExternalAgentAuthResponseSchema },
        detail: { summary: 'Start a provider-owned external agent login flow' }
      }
    )
    .get(
      '/external-agents/:name/auth/status',
      ({ params }) => handlers.externalAgent.authStatus({ agentName: params.name }),
      {
        params: externalAgentNameParams,
        response: { 200: externalAgentAuthStatusResponseSchema },
        detail: { summary: 'Check provider-owned external agent login status' }
      }
    )
    .get('/external-agents/:name/usage', ({ params }) => handlers.externalAgent.usage({ agentName: params.name }), {
      params: externalAgentNameParams,
      response: { 200: externalAgentUsageResponseSchema },
      detail: { summary: 'Read provider-owned external agent usage records' }
    })
    .get(
      '/external-agent-auth-sessions/:id',
      ({ params, query }) => handlers.externalAgent.getAuth({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentAuthScopeQuery,
        response: { 200: getExternalAgentAuthSessionResponseSchema },
        detail: { summary: 'Get an external agent auth session snapshot' }
      }
    )
    .get(
      '/external-agent-auth-sessions/:id/events',
      ({ params, query }) => createExternalAgentAuthEventsSseResponse(handlers, params.id, query.controlToken, encoder),
      {
        params: externalAgentParams,
        query: externalAgentAuthScopeQuery,
        detail: { summary: 'Stream external agent auth session snapshots', tags: ['http-only'] }
      }
    )
    .post(
      '/external-agent-auth-sessions/:id/input',
      ({ params, query, body }) => handlers.externalAgent.inputAuth({ id: params.id, ...query, ...body }),
      {
        params: externalAgentParams,
        query: externalAgentAuthScopeQuery,
        body: externalAgentInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to an external agent auth session' }
      }
    )
    .post(
      '/external-agent-auth-sessions/:id/resize',
      ({ params, query, body }) => handlers.externalAgent.resizeAuth({ id: params.id, ...query, ...body }),
      {
        params: externalAgentParams,
        query: externalAgentAuthScopeQuery,
        body: externalAgentResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize an external agent auth PTY' }
      }
    )
    .post(
      '/external-agent-auth-sessions/:id/heartbeat',
      ({ params, query }) => handlers.externalAgent.heartbeatAuth({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentAuthScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Keep an external agent auth PTY attached to a live browser surface', tags: ['http-only'] }
      }
    )
    .post(
      '/external-agent-auth-sessions/:id/stop',
      ({ params, query }) => handlers.externalAgent.stopAuth({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentAuthScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Stop an external agent auth session' }
      }
    );
}
