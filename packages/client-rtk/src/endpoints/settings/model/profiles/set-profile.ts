import type { OkResponse, ProfileView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProfilesApi, profileAdapter } from './list-profiles.ts';

export const setProfileApi = listProfilesApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setProfile: builder.mutation<OkResponse, ProfileView>({
      queryFn: (profile: ProfileView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.profiles({ alias: profile.alias }).put({ profile })),
      async onQueryStarted(profile, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listProfilesApi.util.updateQueryData('listProfiles', undefined, (draft) => {
            profileAdapter.upsertOne(draft.profiles, profile);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Profiles']
    })
  })
});

export const { useSetProfileMutation } = setProfileApi;
