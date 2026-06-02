import type { ListAtomPacksResponse, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { installAtomPackApi } from './install-atom-pack.ts';
import { listAtomPacksApi } from './list-atom-packs.ts';

export interface SetAtomPackEnabledArgs {
  name: string;
  enabled: boolean;
}

export const setAtomPackEnabledApi = installAtomPackApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setAtomPackEnabled: builder.mutation<OkResponse, SetAtomPackEnabledArgs>({
      queryFn: ({ name, enabled }: SetAtomPackEnabledArgs, api: { extra: unknown }) =>
        runTreaty(() => {
          const pack = clientOf(api).treaty.v1.atoms({ name });
          return enabled ? pack.enable.post() : pack.disable.post();
        }),
      async onQueryStarted({ name, enabled }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listAtomPacksApi.util.updateQueryData('listAtomPacks', undefined, (draft: ListAtomPacksResponse) => {
            const pack = draft.atomPacks.find((p) => p.name === name);
            if (pack) pack.enabled = enabled;
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Atoms', 'Skills', 'SkillsSettings']
    })
  })
});

export const { useSetAtomPackEnabledMutation } = setAtomPackEnabledApi;
