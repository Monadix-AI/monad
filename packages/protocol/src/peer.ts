// Peer settings wire types. A "peer" is another monad daemon this one can delegate tasks to over
// its OpenAI-compat API (see apps/monad services/peer-delegate). The token never crosses a read
// response; writes use the separate credential endpoint and persistence belongs to the peer entry.

import { z } from 'zod';

import { peerIdSchema } from './ids.ts';
import { httpUrlSchema } from './url.ts';

// What a client may see. The raw token is intentionally absent.
export const peerViewSchema = z
  .object({
    id: peerIdSchema,
    label: z.string().min(1),
    baseUrl: httpUrlSchema,
    defaultAgent: z.string().default('default'),
    credentialConfigured: z.boolean(),
    enabled: z.boolean()
  })
  .strict();
export type PeerView = z.infer<typeof peerViewSchema>;

export const listPeersResponseSchema = z.object({ peers: z.array(peerViewSchema) });
export type ListPeersResponse = z.infer<typeof listPeersResponseSchema>;

export const getPeerResponseSchema = z.object({ peer: peerViewSchema });
export type GetPeerResponse = z.infer<typeof getPeerResponseSchema>;

export const upsertPeerRequestSchema = z.object({ peer: peerViewSchema.omit({ credentialConfigured: true }) });
export type UpsertPeerRequest = z.infer<typeof upsertPeerRequestSchema>;

export const setPeerCredentialRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('replace'),
      value: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith('${secret:'), {
          message: 'peer credential token must be stored directly'
        })
    })
    .strict(),
  z.object({ action: z.literal('remove') }).strict()
]);
export type SetPeerCredentialRequest = z.infer<typeof setPeerCredentialRequestSchema>;

// Reachability probe: hits the peer's own /health alongside its configured OpenAI-compat base.
// Mirrors the model provider `test-connection` shape (ok + latency + optional error), scoped down
// to a single boolean since a peer has no model catalog to enumerate.
export const testPeerConnectionResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  error: z.string().optional()
});
export type TestPeerConnectionResponse = z.infer<typeof testPeerConnectionResponseSchema>;
