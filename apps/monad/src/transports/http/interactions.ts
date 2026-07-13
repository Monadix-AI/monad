import type { HostInteractionService } from '#/interactions/service.ts';

import { Elysia, t } from 'elysia';

const interactionType = t.Union([t.Literal('confirm'), t.Literal('select'), t.Literal('form')]);
const fieldType = t.Union([
  t.Literal('string'),
  t.Literal('secret'),
  t.Literal('number'),
  t.Literal('boolean'),
  t.Literal('select')
]);

const capabilities = t.Object({
  interactionTypes: t.Array(interactionType),
  fieldTypes: t.Array(fieldType),
  supportsSecretInput: t.Boolean(),
  supportsBackgroundQueue: t.Boolean()
});

const leaseBody = t.Object({ leaseToken: t.String({ minLength: 1 }) });

export function createInteractionsController(service: HostInteractionService) {
  return new Elysia({ tags: ['http-only'] })
    .get('/interactions', () => ({ interactions: service.listPending() }))
    .get('/interactions/events', () => {
      const encoder = new TextEncoder();
      let unsubscribe = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: unknown) =>
            controller.enqueue(encoder.encode(`event: interaction\ndata: ${JSON.stringify(event)}\n\n`));
          for (const interaction of service.listPending()) send({ type: 'upsert', interaction });
          unsubscribe = service.subscribe(send);
        },
        cancel() {
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
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        body: t.Object({ presenterId: t.String({ minLength: 1 }), capabilities })
      }
    )
    .post(
      '/interactions/:id/submit',
      ({ params, body }) => {
        service.submit(params.id, body.leaseToken, body.values);
        return { ok: true as const };
      },
      {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        body: t.Object({ ...leaseBody.properties, values: t.Record(t.String(), t.Unknown()) })
      }
    )
    .post(
      '/interactions/:id/cancel',
      ({ params, body }) => {
        service.cancel(params.id, body.leaseToken, body.reason);
        return { ok: true as const };
      },
      {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        body: t.Object({
          ...leaseBody.properties,
          reason: t.Union([
            t.Literal('close'),
            t.Literal('escape'),
            t.Literal('timeout'),
            t.Literal('disconnect'),
            t.Literal('unavailable')
          ])
        })
      }
    )
    .post(
      '/interactions/presenters/:presenterId/release',
      ({ params }) => {
        service.releasePresenter(params.presenterId);
        return { ok: true as const };
      },
      { params: t.Object({ presenterId: t.String({ minLength: 1 }) }) }
    );
}
