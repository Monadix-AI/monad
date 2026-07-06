import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { openDraftAttachmentRequestSchema, openDraftAttachmentResponseSchema } from '@monad/protocol';
import { Elysia } from 'elysia';

import { openDraftAttachment } from '@/handlers/session/workspace-actions.ts';

export function createDraftAttachmentsController(_handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] }).post(
    '/draft-attachments/open',
    async ({ body }) => {
      await openDraftAttachment({
        data: new Uint8Array(Buffer.from(body.dataBase64, 'base64')),
        name: body.name
      });
      return { ok: true as const };
    },
    {
      body: openDraftAttachmentRequestSchema,
      response: { 200: openDraftAttachmentResponseSchema },
      detail: {
        summary: 'Open a draft attachment on the daemon host',
        description: 'Writes a composer draft attachment to a daemon-side temporary file and opens it.'
      }
    }
  );
}
