import type { OkResponse, ProfileView, RenameProfileRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { deleteProfileApi } from './delete-profile.ts';
import { listProfilesApi, profileAdapter } from './list-profiles.ts';

const renameProfileApi = deleteProfileApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    renameProfile: builder.mutation<OkResponse, { alias: string; nextAlias: RenameProfileRequest['alias'] }>({
      queryFn: async ({ alias, nextAlias }, api: { extra: unknown }) => {
        return runTreaty(() =>
          clientOf(api).treaty.v1.settings.model.profiles({ alias }).alias.patch({ alias: nextAlias })
        );
      },
      async onQueryStarted({ alias, nextAlias }, { dispatch, queryFulfilled }) {
        const trimmed = nextAlias.trim();
        const patch = dispatch(
          listProfilesApi.util.updateQueryData('listProfiles', undefined, (draft) => {
            const profile = draft.profiles.entities[alias] as ProfileView | undefined;
            if (!profile) return;
            profileAdapter.removeOne(draft.profiles, alias);
            profileAdapter.upsertOne(draft.profiles, { ...profile, alias: trimmed });
            if (draft.defaultAlias === alias) draft.defaultAlias = trimmed;
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Profiles', 'Default', 'Agents', 'InitStatus']
    })
  })
});

export const { useRenameProfileMutation } = renameProfileApi;
