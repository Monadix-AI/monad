import { apiSlice } from '../../api-slice.ts';
import { clientOf, toError } from '../../endpoint-helpers.ts';

const downloadAttachmentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    // `?download=1` streams the raw file and bypasses schema validation on the daemon
    // side (see packages/protocol/src/http.ts's attachmentRead comment) — the response
    // is binary, so this stays a mutation (one-shot user action) returning a Blob rather
    // than a cacheable, serializable query result.
    downloadAttachment: builder.mutation<{ blob: Blob }, { id: string }>({
      queryFn: async ({ id }, api: { extra: unknown }) => {
        try {
          const res = await clientOf(api).fetch(`/v1/attachments/${encodeURIComponent(id)}?download=1`);
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { error: toError({ status: res.status, value: body }) };
          }
          return { data: { blob: await res.blob() } };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useDownloadAttachmentMutation } = downloadAttachmentApi;
