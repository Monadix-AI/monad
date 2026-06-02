import type { StartupSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const getStartupApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getStartup: builder.query<StartupSettings, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.startup.get()),
      providesTags: ['StartupSettings']
    })
  })
});

export const { useGetStartupQuery } = getStartupApi;
