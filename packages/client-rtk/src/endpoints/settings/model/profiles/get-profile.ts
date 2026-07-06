import type { GetProfileResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProfilesApi } from './list-profiles.ts';

const getProfileApi = listProfilesApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getProfile: builder.query<GetProfileResponse, string>({
      queryFn: (alias: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.profiles({ alias }).get()),
      providesTags: (_res, _err, alias) => [{ type: 'Profiles', id: alias }]
    })
  })
});

export const { useGetProfileQuery } = getProfileApi;
