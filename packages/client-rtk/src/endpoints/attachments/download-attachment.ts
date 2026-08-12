import type { FilePreviewTarget } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, toError } from '../../endpoint-helpers.ts';
import { filePreviewUrl } from './file-preview-url.ts';

async function download(url: string, api: { extra: unknown }) {
  try {
    const res = await clientOf(api).fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: toError({ status: res.status, value: body }) };
    }
    return { data: { blob: await res.blob() } };
  } catch (err) {
    return { error: toError(err) };
  }
}

const downloadAttachmentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    downloadFilePreview: builder.mutation<{ blob: Blob }, FilePreviewTarget>({
      queryFn: (target, api: { extra: unknown }) => download(filePreviewUrl(target, 'download'), api)
    })
  })
});

export const { useDownloadFilePreviewMutation } = downloadAttachmentApi;
