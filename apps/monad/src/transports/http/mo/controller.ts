import type { createMoModule } from '@/handlers/mo/handlers.ts';

import { okResponseSchema } from '@monad/protocol';
import { Elysia } from 'elysia';

import { moDropRequestSchema, moDropResponseSchema, moStatusResponseSchema } from '@/handlers/mo/schema.ts';

// The return type is erased to the bare `Elysia` on purpose. Mo talks to the daemon over its own
// native client (libcurl), never the Eden treaty, so the web client never needs these routes typed.
// Letting the treaty infer four more routes off the app tips its type inference past TS's
// instantiation ceiling and degrades every web-client endpoint's types; erasing the route generics
// keeps them out of the treaty while the routes still register and serve at runtime. For the same
// reason Mo is wired here (transport layer) rather than via createDaemonHandlers' return.
export function createMoController(mo: ReturnType<typeof createMoModule>): Elysia {
  return new Elysia()
    .post('/v1/mo/drop', async ({ body }) => mo.drop(body), {
      body: moDropRequestSchema,
      response: { 200: moDropResponseSchema },
      detail: { summary: 'Mo desktop drop', description: 'Creates a session seeded with dropped file(s)/folder(s).' }
    })
    .post('/v1/mo/launch', async () => mo.launch(), {
      response: { 200: okResponseSchema },
      detail: { summary: 'Launch Mo', description: 'Starts the Mo desktop sprite process.' }
    })
    .post('/v1/mo/quit', async () => mo.quit(), {
      response: { 200: okResponseSchema },
      detail: { summary: 'Quit Mo', description: 'Stops the Mo desktop sprite process.' }
    })
    .get('/v1/mo/status', () => mo.status(), {
      response: { 200: moStatusResponseSchema },
      detail: { summary: 'Mo status', description: 'Returns whether the Mo process is running.' }
    }) as unknown as Elysia;
}
