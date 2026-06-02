import type { DiscoverAtomKindsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listAtomKindsApi } from './list-atom-kinds.ts';

export const discoverAtomKindsApi = listAtomKindsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    // Rescan the on-disk atom-pack directory and hot-register what's there (returns newly registered
    // packs + any manifest errors). Lets a pack dropped on disk load without a daemon restart.
    discoverAtomKinds: builder.mutation<DiscoverAtomKindsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model['atom-kinds'].discover.post()),
      invalidatesTags: ['Atoms', 'SlashCommands']
    })
  })
});

export const { useDiscoverAtomKindsMutation } = discoverAtomKindsApi;
