import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProfilesApi, profileAdapter } from './list-profiles.ts';
import { setProfileApi } from './set-profile.ts';

export const deleteProfileApi = setProfileApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteProfile: builder.mutation<null, string>({
      queryFn: (alias: string, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.profiles({ alias }).delete(),
          () => null
        ),
      async onQueryStarted(alias, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listProfilesApi.util.updateQueryData('listProfiles', undefined, (draft) => {
            profileAdapter.removeOne(draft.profiles, alias);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Profiles', 'Default']
    })
  })
});

export const { useDeleteProfileMutation } = deleteProfileApi;
