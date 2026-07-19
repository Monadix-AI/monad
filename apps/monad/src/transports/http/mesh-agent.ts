import type { MeshAgentAuthSessionView, MeshConvenienceFrame, MeshRawEvent } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  getMeshAgentAuthSessionResponseSchema,
  getMeshSessionResponseSchema,
  getNativeAgentDeliveryResponseSchema,
  listMeshAgentRuntimesQuerySchema,
  listMeshAgentRuntimesResponseSchema,
  listMeshSessionsResponseSchema,
  meshAgentApprovalResolutionRequestSchema,
  meshAgentAuthStatusResponseSchema,
  meshAgentInputRequestSchema,
  meshAgentResizeRequestSchema,
  meshAgentUsageResponseSchema,
  meshConnectionSnapshotSchema,
  meshConvenienceEventPageSchema,
  meshEventPageRequestSchema,
  meshRawEventPageSchema,
  nativeAgentDeliveryIdSchema,
  okResponseSchema,
  sessionIdSchema,
  startMeshAgentAuthResponseSchema,
  startMeshAgentRequestSchema,
  startMeshAgentResponseSchema
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

const meshSessionParams = z.object({ id: z.string() });
const meshAuthSessionParams = z.object({ id: z.string() });
const nativeAgentDeliveryParams = z.object({ id: nativeAgentDeliveryIdSchema });
const meshAgentNameParams = z.object({ name: z.string().min(1) });
const meshAgentScopeQuery = z.object({ transcriptTargetId: sessionIdSchema });
// `Last-Event-ID` is the SSE-native resume channel and WINS over `?after=`: a native EventSource
// replays its ORIGINAL url on reconnect, so a query cursor there is frozen at subscribe time while
// the header is current. `?after=` stays as the explicit override for callers that cannot set
// headers. An unparseable value is not rejected — the codec degrades it to "no position" so a
// corrupt cursor replays the epoch instead of 400ing a reconnect.
const meshAgentStreamQuery = meshAgentScopeQuery.extend({ after: z.string().min(1).optional() });

function resumeCursor(headers: Record<string, string | undefined>, after: string | undefined): string | undefined {
  return headers['last-event-id'] ?? after;
}
const meshEventViewPageQuery = meshAgentScopeQuery.merge(meshEventPageRequestSchema.omit({ view: true }));
const meshAgentAuthScopeQuery = z.object({ controlToken: z.string().min(32) });

function createMeshAgentAuthEventsSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  controlToken: string,
  encoder: TextEncoder
): Response {
  return createPushSseResponse<MeshAgentAuthSessionView>({
    encoder,
    encode: (session) => encodeSseFrame({ event: 'mesh.auth', data: session }, encoder),
    subscribe: (emit) => {
      const subscription = handlers.meshAgent.subscribeAuth({
        id,
        controlToken,
        onSession: (session) => emit(session)
      });
      emit(subscription.session);
      return { dispose: subscription.dispose };
    }
  });
}

// The raw diagnostic plane: verbatim provider frames delivered in order, each resumable by its
// `cursor`. Unlike the UI/convenience planes there is no terminal frame in the raw contract, so this
// builder closes the stream explicitly on disconnect (`onDone`) rather than emitting a marker.
function createMeshAgentRawObservationSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  transcriptTargetId: `ses_${string}`,
  encoder: TextEncoder,
  after: string | undefined
): Response {
  const encode = (frame: MeshRawEvent): Uint8Array =>
    encodeSseFrame({ id: frame.cursor, event: 'mesh.raw_observation', data: frame }, encoder);
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
      const sink = createBoundedSseEncoderSink<MeshRawEvent>(ctrl, encode, () => {
        stopHeartbeat?.();
        disposeHub();
      });
      try {
        const sub = handlers.meshAgent.subscribeRawObservation({
          id,
          transcriptTargetId,
          after,
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

// The convenience plane: a `ready` handshake then atomic patches, terminated by an `unavailable`
// frame on disconnect. Rides the generic push helper because its terminal state is a real frame in
// the contract.
//
// Every frame that carries a position writes an SSE `id:`, INCLUDING `ready`. Without an id on
// `ready`, a client whose cursor was invalidated by an epoch rotation never advances its
// `afterEventId` and re-sends the dead cursor on every reconnect forever.
function convenienceFrameCursor(frame: MeshConvenienceFrame): string | undefined {
  return frame.kind === 'patch' ? frame.cursor : frame.kind === 'ready' ? frame.cursor : undefined;
}

function createMeshAgentConvenienceObservationSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  transcriptTargetId: `ses_${string}`,
  encoder: TextEncoder,
  after: string | undefined
): Response {
  return createPushSseResponse<MeshConvenienceFrame>({
    encoder,
    encode: (frame) => {
      const cursor = convenienceFrameCursor(frame);
      return encodeSseFrame(
        {
          ...(cursor ? { id: cursor } : {}),
          event: 'mesh.convenience_observation',
          data: frame
        },
        encoder
      );
    },
    subscribe: (emit) => {
      const sub = handlers.meshAgent.subscribeConvenienceObservation({
        id,
        transcriptTargetId,
        after,
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

export function createMeshAgentController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const encoder = new TextEncoder();
  return new Elysia()
    .post('/mesh/sessions', async ({ body }) => handlers.meshAgent.start({ request: body }), {
      body: startMeshAgentRequestSchema,
      response: { 200: startMeshAgentResponseSchema },
      detail: { summary: 'Start a MeshAgent in a project' }
    })
    .get('/mesh/sessions', ({ query }) => handlers.meshAgent.list({ sessionId: query.transcriptTargetId }), {
      query: meshAgentScopeQuery,
      response: { 200: listMeshSessionsResponseSchema },
      detail: { summary: 'List MeshAgent sessions for a project' }
    })
    .get('/mesh/runtimes', ({ query }) => handlers.meshAgent.listLive(query), {
      query: listMeshAgentRuntimesQuerySchema,
      response: { 200: listMeshAgentRuntimesResponseSchema },
      detail: { summary: 'List all live MeshAgent/agent-adapter runtimes daemon-wide', tags: ['http-only'] }
    })
    .get('/mesh/session-summaries', ({ query }) => handlers.meshAgent.listAllSummaries(query), {
      query: listMeshAgentRuntimesQuerySchema,
      response: { 200: listMeshAgentRuntimesResponseSchema },
      detail: { summary: 'List MeshAgent session summaries daemon-wide', tags: ['http-only'] }
    })
    .get('/mesh/sessions/:id', ({ params, query }) => handlers.meshAgent.get({ id: params.id, ...query }), {
      params: meshSessionParams,
      query: meshAgentScopeQuery,
      response: { 200: getMeshSessionResponseSchema },
      detail: { summary: 'Get a MeshAgent session snapshot' }
    })
    .get(
      '/mesh/sessions/:id/stream/raw',
      ({ params, query, headers }) =>
        createMeshAgentRawObservationSseResponse(
          handlers,
          params.id,
          query.transcriptTargetId,
          encoder,
          resumeCursor(headers, query.after)
        ),
      {
        params: meshSessionParams,
        query: meshAgentStreamQuery,
        detail: { summary: 'Stream verbatim raw MeshAgent observation frames', tags: ['http-only'] }
      }
    )
    .get(
      '/mesh/sessions/:id/stream/convenience',
      ({ params, query, headers }) =>
        createMeshAgentConvenienceObservationSseResponse(
          handlers,
          params.id,
          query.transcriptTargetId,
          encoder,
          resumeCursor(headers, query.after)
        ),
      {
        params: meshSessionParams,
        query: meshAgentStreamQuery,
        detail: { summary: 'Stream incremental convenience MeshAgent observation frames', tags: ['http-only'] }
      }
    )
    .get(
      '/mesh/sessions/:id/events/raw',
      ({ params, query }) => {
        const { transcriptTargetId, ...request } = query;
        return handlers.meshAgent.getRawEvents({ id: params.id, transcriptTargetId, request });
      },
      {
        params: meshSessionParams,
        query: meshEventViewPageQuery,
        response: { 200: meshRawEventPageSchema },
        detail: { summary: 'Load a page of exact provider-native MeshAgent events', tags: ['http-only'] }
      }
    )
    .get(
      '/mesh/sessions/:id/events/convenience',
      ({ params, query }) => {
        const { transcriptTargetId, ...request } = query;
        return handlers.meshAgent.getConvenienceEvents({ id: params.id, transcriptTargetId, request });
      },
      {
        params: meshSessionParams,
        query: meshEventViewPageQuery,
        response: { 200: meshConvenienceEventPageSchema },
        detail: { summary: 'Load MeshAgent events projected into convenience frames', tags: ['http-only'] }
      }
    )
    .get(
      '/mesh/sessions/:id/connection',
      ({ params, query }) => handlers.meshAgent.connectionSnapshot({ id: params.id, ...query }),
      {
        params: meshSessionParams,
        query: meshAgentScopeQuery,
        response: { 200: meshConnectionSnapshotSchema },
        detail: { summary: 'Read the MeshAgent observation connection snapshot', tags: ['http-only'] }
      }
    )
    .get('/mesh/deliveries/:id', ({ params, query }) => handlers.meshAgent.delivery({ id: params.id, ...query }), {
      params: nativeAgentDeliveryParams,
      query: meshAgentScopeQuery,
      response: { 200: getNativeAgentDeliveryResponseSchema },
      detail: { summary: 'Read managed MeshAgent delivery pointer state', tags: ['http-only'] }
    })
    .post(
      '/mesh/sessions/:id/input',
      ({ params, query, body }) => handlers.meshAgent.input({ id: params.id, ...query, ...body }),
      {
        params: meshSessionParams,
        query: meshAgentScopeQuery,
        body: meshAgentInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to a MeshAgent session' }
      }
    )
    .post(
      '/mesh/sessions/:id/interrupt',
      ({ params, query }) => handlers.meshAgent.interrupt({ id: params.id, ...query }),
      {
        params: meshSessionParams,
        query: meshAgentScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Cancel the in-flight turn of a MeshAgent session' }
      }
    )
    .post(
      '/mesh/sessions/:id/steer',
      ({ params, query, body }) => handlers.meshAgent.steer({ id: params.id, ...query, ...body }),
      {
        params: meshSessionParams,
        query: meshAgentScopeQuery,
        body: meshAgentInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Inject input into the in-flight turn of a MeshAgent session' }
      }
    )
    .post(
      '/mesh/sessions/:id/approval',
      ({ params, query, body }) => handlers.meshAgent.approval({ id: params.id, ...query, ...body }),
      {
        params: meshSessionParams,
        query: meshAgentScopeQuery,
        body: meshAgentApprovalResolutionRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resolve a provider-owned MeshAgent approval request' }
      }
    )
    .post(
      '/mesh/sessions/:id/resize',
      ({ params, query, body }) => handlers.meshAgent.resize({ id: params.id, ...query, ...body }),
      {
        params: meshSessionParams,
        query: meshAgentScopeQuery,
        body: meshAgentResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize a MeshAgent PTY' }
      }
    )
    .post('/mesh/sessions/:id/stop', ({ params, query }) => handlers.meshAgent.stop({ id: params.id, ...query }), {
      params: meshSessionParams,
      query: meshAgentScopeQuery,
      response: { 200: okResponseSchema },
      detail: { summary: 'Stop a MeshAgent session' }
    })
    .post('/mesh/agents/:name/auth/start', ({ params }) => handlers.meshAgent.startAuth({ agentName: params.name }), {
      params: meshAgentNameParams,
      response: { 200: startMeshAgentAuthResponseSchema },
      detail: { summary: 'Start a provider-owned MeshAgent login flow' }
    })
    .get('/mesh/agents/:name/auth/status', ({ params }) => handlers.meshAgent.authStatus({ agentName: params.name }), {
      params: meshAgentNameParams,
      response: { 200: meshAgentAuthStatusResponseSchema },
      detail: { summary: 'Check provider-owned MeshAgent login status' }
    })
    .get('/mesh/agents/:name/usage', ({ params }) => handlers.meshAgent.usage({ agentName: params.name }), {
      params: meshAgentNameParams,
      response: { 200: meshAgentUsageResponseSchema },
      detail: { summary: 'Read provider-owned MeshAgent usage records' }
    })
    .get('/mesh/auth-sessions/:id', ({ params, query }) => handlers.meshAgent.getAuth({ id: params.id, ...query }), {
      params: meshAuthSessionParams,
      query: meshAgentAuthScopeQuery,
      response: { 200: getMeshAgentAuthSessionResponseSchema },
      detail: { summary: 'Get a MeshAgent auth session snapshot' }
    })
    .get(
      '/mesh/auth-sessions/:id/events',
      ({ params, query }) => createMeshAgentAuthEventsSseResponse(handlers, params.id, query.controlToken, encoder),
      {
        params: meshAuthSessionParams,
        query: meshAgentAuthScopeQuery,
        detail: { summary: 'Stream MeshAgent auth session snapshots', tags: ['http-only'] }
      }
    )
    .post(
      '/mesh/auth-sessions/:id/input',
      ({ params, query, body }) => handlers.meshAgent.inputAuth({ id: params.id, ...query, ...body }),
      {
        params: meshAuthSessionParams,
        query: meshAgentAuthScopeQuery,
        body: meshAgentInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to a MeshAgent auth session' }
      }
    )
    .post(
      '/mesh/auth-sessions/:id/resize',
      ({ params, query, body }) => handlers.meshAgent.resizeAuth({ id: params.id, ...query, ...body }),
      {
        params: meshAuthSessionParams,
        query: meshAgentAuthScopeQuery,
        body: meshAgentResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize a MeshAgent auth PTY' }
      }
    )
    .post(
      '/mesh/auth-sessions/:id/heartbeat',
      ({ params, query }) => handlers.meshAgent.heartbeatAuth({ id: params.id, ...query }),
      {
        params: meshAuthSessionParams,
        query: meshAgentAuthScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Keep a MeshAgent auth PTY attached to a live browser surface', tags: ['http-only'] }
      }
    )
    .post(
      '/mesh/auth-sessions/:id/stop',
      ({ params, query }) => handlers.meshAgent.stopAuth({ id: params.id, ...query }),
      {
        params: meshAuthSessionParams,
        query: meshAgentAuthScopeQuery,
        response: { 200: okResponseSchema },
        detail: { summary: 'Stop a MeshAgent auth session' }
      }
    );
}
