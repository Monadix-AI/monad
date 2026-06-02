import type { OpenDraftAttachmentRequest, OpenDraftAttachmentResponse } from '@monad/protocol';

import { openDraftAttachmentResponseSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, toError } from '../../endpoint-helpers.ts';

const openDraftAttachmentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    // `/v1/draft-attachments/open` is on an http-only controller (no Treaty typing) —
    // same raw-fetch pattern as transcribeAudio.
    openDraftAttachment: builder.mutation<OpenDraftAttachmentResponse, OpenDraftAttachmentRequest>({
      queryFn: async (args, api: { extra: unknown }) => {
        try {
          const res = await clientOf(api).fetch('/v1/draft-attachments/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args)
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) return { error: toError({ status: res.status, value: body }) };
          return { data: openDraftAttachmentResponseSchema.parse(body) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useOpenDraftAttachmentMutation } = openDraftAttachmentApi;
