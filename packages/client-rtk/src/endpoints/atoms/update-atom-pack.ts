import type { InstallAtomPackResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { removeAtomPackApi } from './remove-atom-pack.ts';

export const updateAtomPackApi = removeAtomPackApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateAtomPack: builder.mutation<InstallAtomPackResponse, { name: string; revision: string }>({
      queryFn: ({ name, revision }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms({ name }).update.post({ confirm: true, revision })),
      invalidatesTags: ['Atoms', 'SlashCommands']
    })
  })
});

export const { useUpdateAtomPackMutation } = updateAtomPackApi;
