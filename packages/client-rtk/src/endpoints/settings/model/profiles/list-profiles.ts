import type { ListProfilesResponse, ProfileView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { deleteProviderApi } from '../providers/delete-provider.ts';

export const profileAdapter = createEntityAdapter<ProfileView, string>({ selectId: (p) => p.alias });
export const profileSelectors = profileAdapter.getSelectors();

export type ListProfilesResult = Omit<ListProfilesResponse, 'profiles'> & {
  profiles: EntityState<ProfileView, string>;
};

export const listProfilesApi = deleteProviderApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listProfiles: builder.query<ListProfilesResult, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.profiles.get(),
          (raw) => ({
            profiles: profileAdapter.setAll(profileAdapter.getInitialState(), raw.profiles),
            defaultAlias: raw.defaultAlias
          })
        ),
      providesTags: ['Profiles', 'Default']
    })
  })
});

export const { useListProfilesQuery } = listProfilesApi;
