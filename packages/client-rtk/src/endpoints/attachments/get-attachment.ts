import type { AttachmentReadResponse } from '@monad/protocol';

import { attachmentReadResponseSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, toError } from '../../endpoint-helpers.ts';

const getAttachmentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    // `/v1/attachments/:id` lives on an http-only controller (no Treaty typing) —
    // same raw-fetch pattern as transcribeAudio.
    getAttachment: builder.query<AttachmentReadResponse, { id: string }>({
      queryFn: async ({ id }, api: { extra: unknown }) => {
        try {
          const res = await clientOf(api).fetch(`/v1/attachments/${encodeURIComponent(id)}`);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) return { error: toError({ status: res.status, value: body }) };
          return { data: attachmentReadResponseSchema.parse(body) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useGetAttachmentQuery, useLazyGetAttachmentQuery } = getAttachmentApi;
