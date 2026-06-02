import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  listPeersResponseSchema,
  okResponseSchema,
  peerIdSchema,
  setPeerCredentialRequestSchema,
  upsertPeerRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// HTTP-only surface: peers are a management plane (like channel/mcp settings). Secrets never come
// back out — the token goes in via /credential and is stored in auth.json.
const peerParams = z.object({ id: peerIdSchema });

export function createPeerSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/peers', async () => handlers.peer.listPeers(), {
      response: { 200: listPeersResponseSchema },
      detail: { summary: 'List peers', description: 'Returns configured peer daemons (no secrets).' }
    })
    .put('/peers', async ({ body }) => handlers.peer.upsertPeer(body), {
      body: upsertPeerRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Upsert peer', description: 'Creates or updates a peer daemon entry.' }
    })
    .post('/peers/:id/enable', async ({ params }) => handlers.peer.setPeerEnabled({ id: params.id, enabled: true }), {
      params: peerParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Enable peer', description: 'Enables a peer daemon entry.' }
    })
    .post('/peers/:id/disable', async ({ params }) => handlers.peer.setPeerEnabled({ id: params.id, enabled: false }), {
      params: peerParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Disable peer', description: 'Disables a peer daemon entry.' }
    })
    .delete('/peers/:id', async ({ params }) => handlers.peer.removePeer({ id: params.id }), {
      params: peerParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Remove peer', description: 'Deletes a peer daemon entry and its credential.' }
    })
    .put(
      '/peers/:id/credential',
      async ({ params, body }) => handlers.peer.setPeerCredential({ id: params.id, ...body }),
      {
        params: peerParams,
        body: setPeerCredentialRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Set peer credential', description: "Stores the peer's bearer token in auth.json." }
      }
    );
}
