import type { InstallAtomPackResponse, UploadAtomPackQuery } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { listAtomPacksApi } from './list-atom-packs.ts';

type UploadAtomPackArg = { filename: string; body: BodyInit; consent?: boolean; contentType?: string };

const uploadAtomPackApi = listAtomPacksApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    uploadAtomPack: builder.mutation<InstallAtomPackResponse, UploadAtomPackArg>({
      queryFn: async (body, api: { extra: unknown }) => {
        const query: UploadAtomPackQuery = { filename: body.filename, consent: String(body.consent ?? false) };
        const params = new URLSearchParams(query);
        const res = await clientOf(api).fetch(`/v1/atoms/install/upload?${params}`, {
          method: 'POST',
          headers: { 'content-type': body.contentType ?? 'application/octet-stream' },
          body: body.body
        });
        if (!res.ok) {
          const parsed = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
          return { error: { status: res.status, code: parsed?.code, message: parsed?.error ?? res.statusText } };
        }
        return { data: (await res.json()) as InstallAtomPackResponse };
      },
      invalidatesTags: (result) => (result?.needsConsent ? [] : ['Atoms'])
    })
  })
});

export const { useUploadAtomPackMutation } = uploadAtomPackApi;
