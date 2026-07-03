import type { SetUserProfileSettingsRequest, UserProfileSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getProfileSettingsApi } from './get-profile-settings.ts';

type UserProfileSettingsTreaty = {
  profile: {
    put: (
      body: SetUserProfileSettingsRequest
    ) => Promise<{ data: UserProfileSettings | null | undefined; error: unknown }>;
  };
};

const setProfileSettingsApi = getProfileSettingsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setProfileSettings: builder.mutation<UserProfileSettings, SetUserProfileSettingsRequest>({
      queryFn: (body: SetUserProfileSettingsRequest, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as UserProfileSettingsTreaty;
        return runTreaty(() => settings.profile.put(body));
      },
      async onQueryStarted(body, { dispatch, queryFulfilled }) {
        const patch = dispatch(getProfileSettingsApi.util.updateQueryData('getProfileSettings', undefined, () => body));
        try {
          const { data } = await queryFulfilled;
          dispatch(getProfileSettingsApi.util.updateQueryData('getProfileSettings', undefined, () => data));
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['UserProfileSettings']
    })
  })
});

export const { useSetProfileSettingsMutation } = setProfileSettingsApi;
