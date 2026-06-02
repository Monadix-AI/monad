import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  approveChannelPairingRequestSchema,
  channelIdSchema,
  channelStatusResponseSchema,
  listChannelPairingsResponseSchema,
  listChannelsResponseSchema,
  okResponseSchema,
  setChannelCredentialRequestSchema,
  upsertChannelRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// HTTP-only surface: contract declared inline; reusable wire schemas (incl. the branded channel id)
// come from @monad/protocol. enable/disable derive `enabled` from the path, so they take no body.
const channelParams = z.object({ id: channelIdSchema });

export function createChannelSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/channels', async () => handlers.channel.listChannels(), {
      response: { 200: listChannelsResponseSchema },
      detail: { summary: 'List channels', description: 'Returns configured channel instances (no secrets).' }
    })
    .put('/channels', async ({ body }) => handlers.channel.upsertChannel(body), {
      body: upsertChannelRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Upsert channel', description: 'Creates or updates a channel instance.' }
    })
    .post(
      '/channels/:id/enable',
      async ({ params }) => handlers.channel.setChannelEnabled({ id: params.id, enabled: true }),
      {
        params: channelParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Enable channel', description: 'Enables a channel instance.' }
      }
    )
    .post(
      '/channels/:id/disable',
      async ({ params }) => handlers.channel.setChannelEnabled({ id: params.id, enabled: false }),
      {
        params: channelParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Disable channel', description: 'Disables a channel instance.' }
      }
    )
    .delete('/channels/:id', async ({ params }) => handlers.channel.removeChannel({ id: params.id }), {
      params: channelParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Remove channel', description: 'Deletes a channel instance and its credential.' }
    })
    .put(
      '/channels/:id/credential',
      async ({ params, body }) => handlers.channel.setChannelCredential({ id: params.id, ...body }),
      {
        params: channelParams,
        body: setChannelCredentialRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Set channel credential', description: 'Stores the channel bot token in auth.json.' }
      }
    )
    .get('/channels/:id/pairings', async ({ params }) => handlers.channel.listChannelPairings({ id: params.id }), {
      params: channelParams,
      response: { 200: listChannelPairingsResponseSchema },
      detail: { summary: 'List channel pairings', description: 'Pending pairing requests awaiting approval.' }
    })
    .post(
      '/channels/:id/pair',
      async ({ params, body }) => handlers.channel.approveChannelPairing({ id: params.id, code: body.code }),
      {
        params: channelParams,
        body: approveChannelPairingRequestSchema,
        response: { 200: okResponseSchema },
        detail: { summary: 'Approve channel pairing', description: 'Allowlists the sender behind a pairing code.' }
      }
    )
    .get('/channels/status', async () => handlers.channel.channelStatus(), {
      response: { 200: channelStatusResponseSchema },
      detail: { summary: 'Channel status', description: 'Live connection status per channel.' }
    });
}
