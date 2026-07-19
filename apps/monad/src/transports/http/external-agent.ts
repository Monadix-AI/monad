import type {
  ExternalAgentAuthSessionView,
  ExternalAgentConvenienceFrame,
  ExternalAgentRawFrame,
  ExternalAgentSessionId,
  ExternalAgentUiObservationFrame
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  externalAgentApprovalResolutionRequestSchema,
  externalAgentAuthStatusResponseSchema,
  externalAgentConnectionSnapshotSchema,
  externalAgentConvenienceFrameSchema,
  externalAgentHistoryPageRequestSchema,
  externalAgentHistoryPageResponseSchema,
  externalAgentInputRequestSchema,
  externalAgentObservationAccessResponseSchema,
  externalAgentRawHistoryPageSchema,
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

import {
  createBoundedSseEncoderSink,
  createPushSseResponse,
  createSseResponse,
  encodeSseFrame,
  startSseHeartbeat
} from '#/transports/http/sessions/sse.ts';

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

// The raw diagnostic plane: verbatim provider frames delivered in order, each resumable by its
// `cursor`. Unlike the UI/convenience planes there is no terminal frame in the raw contract, so this
// builder closes the stream explicitly on disconnect (`onDone`) rather than emitting a marker.
function createExternalAgentRawObservationSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  transcriptTargetId: `ses_${string}`,
  encoder: TextEncoder
): Response {
  const encode = (frame: ExternalAgentRawFrame): Uint8Array =>
    encodeSseFrame({ id: frame.cursor, event: 'external_agent.raw_observation', data: frame }, encoder);
  let stopHeartbeat: (() => void) | undefined;
  let disposeHub: () => void = () => {};
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      const close = (): void => {
        if (closed) return;
        closed = true;
        stopHeartbeat?.();
        disposeHub();
        try {
          ctrl.close();
        } catch {
          // already closed/errored — nothing to do
        }
      };
      const sink = createBoundedSseEncoderSink<ExternalAgentRawFrame>(ctrl, encode, () => {
        stopHeartbeat?.();
        disposeHub();
      });
      try {
        const sub = handlers.externalAgent.subscribeRawObservation({
          id,
          transcriptTargetId,
          onFrame: (frame) => sink(frame),
          onDone: () => close()
        });
        disposeHub = sub.dispose;
        for (const frame of sub.frames) sink(frame);
        if (!sub.live) close();
      } catch {
        close();
      }
    },
    cancel() {
      closed = true;
      stopHeartbeat?.();
      disposeHub();
    }
  });
  return createSseResponse(stream);
}

// The convenience plane: a `ready` handshake then incremental `upsert`s of neutral events, terminated
// by an `unavailable` frame on disconnect. Rides the generic push helper because its terminal state is
// a real frame in the contract.
function createExternalAgentConvenienceObservationSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  transcriptTargetId: `ses_${string}`,
  encoder: TextEncoder
): Response {
  return createPushSseResponse<ExternalAgentConvenienceFrame>({
    encoder,
    encode: (frame) => encodeSseFrame({ event: 'external_agent.convenience_observation', data: frame }, encoder),
    subscribe: (emit) => {
      const sub = handlers.externalAgent.subscribeConvenienceObservation({
        id,
        transcriptTargetId,
        onFrame: (frame, done) => emit(frame, done)
      });
      if (!sub.live) {
        const terminal = sub.frames[0];
        if (terminal) emit(terminal, true);
        return { dispose: sub.dispose };
      }
      for (const frame of sub.frames) emit(frame, false);
      return { dispose: sub.dispose };
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
      '/external-agent-sessions/:id/stream/raw',
      ({ params, query }) =>
        createExternalAgentRawObservationSseResponse(handlers, params.id, query.transcriptTargetId, encoder),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        detail: { summary: 'Stream verbatim raw external agent observation frames', tags: ['http-only'] }
      }
    )
    .get(
      '/external-agent-sessions/:id/stream/convenience',
      ({ params, query }) =>
        createExternalAgentConvenienceObservationSseResponse(handlers, params.id, query.transcriptTargetId, encoder),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        detail: { summary: 'Stream incremental convenience external agent observation frames', tags: ['http-only'] }
      }
    )
    .get(
      '/external-agent-sessions/:id/history/raw',
      ({ params, query }) => {
        const { transcriptTargetId, ...request } = query;
        return handlers.externalAgent.observeRawHistory({ id: params.id, transcriptTargetId, request });
      },
      {
        params: externalAgentParams,
        query: externalAgentHistoryPageQuery,
        response: { 200: externalAgentRawHistoryPageSchema },
        detail: { summary: 'Load a page of exact provider-native external agent history records', tags: ['http-only'] }
      }
    )
    .get(
      '/external-agent-sessions/:id/history/convenience',
      ({ params, query }) => {
        const { transcriptTargetId, ...request } = query;
        return handlers.externalAgent.observeConvenienceHistory({ id: params.id, transcriptTargetId, request });
      },
      {
        params: externalAgentParams,
        query: externalAgentHistoryPageQuery,
        response: { 200: z.array(externalAgentConvenienceFrameSchema) },
        detail: { summary: 'Load external agent history projected into convenience frames', tags: ['http-only'] }
      }
    )
    .get(
      '/external-agent-sessions/:id/connection',
      ({ params, query }) => handlers.externalAgent.connectionSnapshot({ id: params.id, ...query }),
      {
        params: externalAgentParams,
        query: externalAgentScopeQuery,
        response: { 200: externalAgentConnectionSnapshotSchema },
        detail: { summary: 'Read the external agent observation connection snapshot', tags: ['http-only'] }
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
