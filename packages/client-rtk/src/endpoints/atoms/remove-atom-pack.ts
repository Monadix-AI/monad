import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { atomPackAdapter, listAtomPacksApi } from './list-atom-packs.ts';
import { setAtomPackEnabledApi } from './set-atom-pack-enabled.ts';

export const removeAtomPackApi = setAtomPackEnabledApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    removeAtomPack: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms({ name }).delete()),
      async onQueryStarted(name, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listAtomPacksApi.util.updateQueryData('listAtomPacks', undefined, (draft) => {
            atomPackAdapter.removeOne(draft.atomPacks, name);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Atoms', 'SlashCommands']
    })
  })
});

export const { useRemoveAtomPackMutation } = removeAtomPackApi;
