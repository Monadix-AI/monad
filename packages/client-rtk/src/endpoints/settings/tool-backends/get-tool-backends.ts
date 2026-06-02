import type { ToolBackendsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getToolBackendsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getToolBackends: builder.query<ToolBackendsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['tool-backends'].get()),
      providesTags: ['ToolBackends']
    })
  })
});

export const { useGetToolBackendsQuery } = getToolBackendsApi;
