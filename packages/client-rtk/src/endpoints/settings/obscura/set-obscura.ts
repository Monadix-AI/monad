import type { ObscuraStatusResponse, SetObscuraRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getObscuraApi } from './get-obscura.ts';

const setObscuraApi = getObscuraApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setObscura: builder.mutation<ObscuraStatusResponse, SetObscuraRequest>({
      queryFn: (body: SetObscuraRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.obscura.put(body)),
      invalidatesTags: ['Obscura']
    })
  })
});

export const { useSetObscuraMutation } = setObscuraApi;
