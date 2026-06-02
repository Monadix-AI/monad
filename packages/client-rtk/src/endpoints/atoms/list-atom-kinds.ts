import type { ListAtomKindsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { removeAtomPackApi } from './remove-atom-pack.ts';

export const listAtomKindsApi = removeAtomPackApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    // The atom kinds registered system-wide (tool/connector/channel/command/message-type/locale/provider).
    listAtomKinds: builder.query<ListAtomKindsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model['atom-kinds'].get()),
      providesTags: ['Atoms']
    })
  })
});

export const { useListAtomKindsQuery } = listAtomKindsApi;
