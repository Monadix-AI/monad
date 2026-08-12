import type { FilePreviewReadResponse, FilePreviewTarget } from '@monad/protocol';

import { filePreviewReadResponseSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, toError } from '../../endpoint-helpers.ts';
import { filePreviewUrl } from './file-preview-url.ts';

async function getPreview<T>(
  url: string,
  parse: (body: unknown) => T,
  api: { extra: unknown }
): Promise<{ data: T } | { error: ReturnType<typeof toError> }> {
  try {
    const res = await clientOf(api).fetch(url);
    const body = await res.json().catch(() => ({}));
    return res.ok ? { data: parse(body) } : { error: toError({ status: res.status, value: body }) };
  } catch (err) {
    return { error: toError(err) };
  }
}

const getAttachmentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getFilePreview: builder.query<FilePreviewReadResponse, FilePreviewTarget>({
      queryFn: (target, api: { extra: unknown }) =>
        getPreview(filePreviewUrl(target), filePreviewReadResponseSchema.parse, api)
    })
  })
});

export const { useGetFilePreviewQuery } = getAttachmentApi;
