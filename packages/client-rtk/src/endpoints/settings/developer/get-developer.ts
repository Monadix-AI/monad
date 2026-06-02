import type { DeveloperSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const getDeveloperApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getDeveloper: builder.query<DeveloperSettings, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.developer.get()),
      providesTags: ['DeveloperSettings']
    })
  })
});

export const { useGetDeveloperQuery } = getDeveloperApi;
