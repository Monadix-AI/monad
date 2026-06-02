import type { HooksSettingsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getHooksApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getHooks: builder.query<HooksSettingsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.hooks.get()),
      providesTags: ['Hooks']
    })
  })
});

export const { useGetHooksQuery } = getHooksApi;
