import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  delegationAckResponseSchema,
  delegationOutputRequestSchema,
  delegationRespondRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';

// Reverse fs/terminal delegation responses from the ACP bridge: the editor answers a
// delegation.{fs,terminal}_request event here. `respond` settles the request; `output` streams
// cumulative terminal output while the command runs.
// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
export function createDelegationController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .post('/delegation/respond', async ({ body }) => handlers.delegation.respond(body), {
      body: delegationRespondRequestSchema,
      response: { 200: delegationAckResponseSchema },
      detail: {
        summary: 'Answer a delegated fs/terminal request',
        description: 'Resolves a pending delegation.{fs,terminal}_request. ok:false → unknown/expired id.'
      }
    })
    .post('/delegation/output', async ({ body }) => handlers.delegation.output(body), {
      body: delegationOutputRequestSchema,
      response: { 200: delegationAckResponseSchema },
      detail: {
        summary: 'Stream incremental output for a delegated terminal command',
        description: 'Feeds cumulative output to a running delegation.terminal_request.'
      }
    });
}
