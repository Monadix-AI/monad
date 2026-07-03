import type { NativeCliAuthSessionView } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  getNativeCliAuthSessionResponseSchema,
  getNativeCliSessionResponseSchema,
  listNativeCliSessionsResponseSchema,
  nativeCliApprovalResolutionRequestSchema,
  nativeCliAuthStatusResponseSchema,
  nativeCliHistoryPageRequestSchema,
  nativeCliHistoryPageResponseSchema,
  nativeCliInputRequestSchema,
  nativeCliResizeRequestSchema,
  okResponseSchema,
  startNativeCliAgentRequestSchema,
  startNativeCliAgentResponseSchema,
  startNativeCliAuthResponseSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { createBoundedSseEncoderSink, createSseResponse, encodeSseFrame } from '@/transports/http/sessions/sse.ts';

const sessionParams = z.object({ id: z.string() });
const nativeCliParams = z.object({ id: z.string() });
const nativeCliAgentParams = z.object({ name: z.string().min(1) });

function createNativeCliAuthEventsSseResponse(
  handlers: ReturnType<typeof createDaemonHandlers>,
  id: string,
  encoder: TextEncoder
): Response {
  const pending: NativeCliAuthSessionView[] = [];
  let sink: ((session: NativeCliAuthSessionView) => void) | undefined;
  const subscription = handlers.nativeCli.subscribeAuth({
    id,
    onSession: (session) => {
      if (sink) sink(session);
      else pending.push(session);
    }
  });
  pending.push(subscription.session);

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      sink = createBoundedSseEncoderSink<NativeCliAuthSessionView>(
        ctrl,
        (session) => encodeSseFrame({ event: 'native_cli.auth', data: session }, encoder),
        subscription.dispose
      );
      for (const session of pending.splice(0)) sink(session);
    },
    cancel() {
      sink = undefined;
      subscription.dispose();
    }
  });
  return createSseResponse(stream);
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
    .get('/native-cli-sessions/:id', ({ params }) => handlers.nativeCli.get({ id: params.id }), {
      params: nativeCliParams,
      response: { 200: getNativeCliSessionResponseSchema },
      detail: { summary: 'Get a native CLI session snapshot' }
    })
    .post(
      '/native-cli-sessions/:id/input',
      ({ params, body }) => handlers.nativeCli.input({ id: params.id, ...body }),
      {
        params: nativeCliParams,
        body: nativeCliInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to a native CLI session' }
      }
    )
    .post(
      '/native-cli-sessions/:id/approval',
      ({ params, body }) => handlers.nativeCli.approval({ id: params.id, ...body }),
      {
        params: nativeCliParams,
        body: nativeCliApprovalResolutionRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resolve a provider-owned native CLI approval request' }
      }
    )
    .post(
      '/native-cli-sessions/:id/resize',
      ({ params, body }) => handlers.nativeCli.resize({ id: params.id, ...body }),
      {
        params: nativeCliParams,
        body: nativeCliResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize a native CLI PTY' }
      }
    )
    .post('/native-cli-sessions/:id/stop', ({ params }) => handlers.nativeCli.stop({ id: params.id }), {
      params: nativeCliParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Stop a native CLI session' }
    })
    .post(
      '/native-cli-sessions/:id/history-page',
      ({ params, body }) => handlers.nativeCli.historyPage({ id: params.id, request: body }),
      {
        params: nativeCliParams,
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
    .get('/native-cli-auth-sessions/:id', ({ params }) => handlers.nativeCli.getAuth({ id: params.id }), {
      params: nativeCliParams,
      response: { 200: getNativeCliAuthSessionResponseSchema },
      detail: { summary: 'Get a native CLI auth session snapshot' }
    })
    .get(
      '/native-cli-auth-sessions/:id/events',
      ({ params }) => createNativeCliAuthEventsSseResponse(handlers, params.id, encoder),
      {
        params: nativeCliParams,
        detail: { summary: 'Stream native CLI auth session snapshots', tags: ['http-only'] }
      }
    )
    .post(
      '/native-cli-auth-sessions/:id/input',
      ({ params, body }) => handlers.nativeCli.inputAuth({ id: params.id, ...body }),
      {
        params: nativeCliParams,
        body: nativeCliInputRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Send input to a native CLI auth session' }
      }
    )
    .post(
      '/native-cli-auth-sessions/:id/resize',
      ({ params, body }) => handlers.nativeCli.resizeAuth({ id: params.id, ...body }),
      {
        params: nativeCliParams,
        body: nativeCliResizeRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Resize a native CLI auth PTY' }
      }
    )
    .post(
      '/native-cli-auth-sessions/:id/heartbeat',
      ({ params }) => handlers.nativeCli.heartbeatAuth({ id: params.id }),
      {
        params: nativeCliParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Keep a native CLI auth PTY attached to a live browser surface', tags: ['http-only'] }
      }
    )
    .post('/native-cli-auth-sessions/:id/stop', ({ params }) => handlers.nativeCli.stopAuth({ id: params.id }), {
      params: nativeCliParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Stop a native CLI auth session' }
    });
}
