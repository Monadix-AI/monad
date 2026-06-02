import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { installAtomPackApi } from './install-atom-pack.ts';
import { atomPackAdapter, listAtomPacksApi } from './list-atom-packs.ts';

export const setAtomPackEnabledApi = installAtomPackApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setAtomPackEnabled: builder.mutation<OkResponse, { name: string; enabled: boolean }>({
      queryFn: ({ name, enabled }, api: { extra: unknown }) =>
        runTreaty(() => {
          const pack = clientOf(api).treaty.v1.atoms({ name });
          return enabled ? pack.enable.post() : pack.disable.post();
        }),
      async onQueryStarted({ name, enabled }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listAtomPacksApi.util.updateQueryData('listAtomPacks', undefined, (draft) => {
            atomPackAdapter.updateOne(draft.atomPacks, { id: name, changes: { enabled } });
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Atoms', 'Skills', 'SkillsSettings', 'SlashCommands']
    })
  })
});

export const { useSetAtomPackEnabledMutation } = setAtomPackEnabledApi;
