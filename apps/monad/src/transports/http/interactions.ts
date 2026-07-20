import type { HostInteractionService } from '#/interactions/service.ts';

import {
  interactionCancelBodySchema,
  interactionClaimBodySchema,
  interactionIdParamsSchema,
  interactionLeaseBodySchema,
  interactionPresenterParamsSchema,
  interactionSubmitBodySchema
} from '@monad/protocol';
import { Elysia } from 'elysia';

import {
  createBoundedSseEncoderSink,
  createByteBoundedSseStream,
  startSseHeartbeat
} from '#/transports/http/sessions/sse.ts';

export function createInteractionsController(service: HostInteractionService, options: { heartbeatMs?: number } = {}) {
  return new Elysia({ tags: ['http-only'] })
    .get('/interactions', () => ({ interactions: service.listPending() }))
    .get('/interactions/events', () => {
      const encoder = new TextEncoder();
      let unsubscribe = () => {};
      let stopHeartbeat = () => {};
      const body = createByteBoundedSseStream({
        start(controller) {
          stopHeartbeat = startSseHeartbeat(controller, encoder, options.heartbeatMs);
          const sink = createBoundedSseEncoderSink(
            controller,
            (frame: string) => encoder.encode(frame),
            () => {
              stopHeartbeat();
              unsubscribe();
            }
          );
          const send = (event: unknown) => sink(`event: interaction\ndata: ${JSON.stringify(event)}\n\n`);
          const pending = service.listPending();
          if (pending.length === 0) sink(': connected\n\n');
          for (const interaction of pending) send({ type: 'upsert', interaction });
          unsubscribe = service.subscribe(send);
        },
        cancel() {
          stopHeartbeat();
          unsubscribe();
        }
      });
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        }
      });
    })
    .post(
      '/interactions/:id/claim',
      ({ params, body }) => service.claim(params.id, body.presenterId, body.capabilities),
      {
        params: interactionIdParamsSchema,
        body: interactionClaimBodySchema
      }
    )
    .post(
      '/interactions/:id/renew',
      ({ params, body }) => {
        service.renew(params.id, body.leaseToken);
        return { ok: true as const };
      },
      {
        params: interactionIdParamsSchema,
        body: interactionLeaseBodySchema
      }
    )
    .post(
      '/interactions/:id/submit',
      ({ params, body }) => {
        service.submit(params.id, body.leaseToken, body.values);
        return { ok: true as const };
      },
      {
        params: interactionIdParamsSchema,
        body: interactionSubmitBodySchema
      }
    )
    .post(
      '/interactions/:id/cancel',
      ({ params, body }) => {
        service.cancel(params.id, body.leaseToken, body.reason);
        return { ok: true as const };
      },
      {
        params: interactionIdParamsSchema,
        body: interactionCancelBodySchema
      }
    )
    .post(
      '/interactions/presenters/:presenterId/release',
      ({ params }) => {
        service.releasePresenter(params.presenterId);
        return { ok: true as const };
      },
      { params: interactionPresenterParamsSchema }
    );
}
