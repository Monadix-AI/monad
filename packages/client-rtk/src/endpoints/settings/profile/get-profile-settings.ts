import type { UserProfileSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

type UserProfileSettingsTreaty = {
  profile: {
    get: () => Promise<{ data: UserProfileSettings | null | undefined; error: unknown }>;
  };
};

export const getProfileSettingsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getProfileSettings: builder.query<UserProfileSettings, void>({
      queryFn: (_arg, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as UserProfileSettingsTreaty;
        return runTreaty(() => settings.profile.get());
      },
      providesTags: ['UserProfileSettings']
    })
  })
});

export const { useGetProfileSettingsQuery } = getProfileSettingsApi;
