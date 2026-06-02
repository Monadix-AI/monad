import type { OpenaiCompatSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getOpenaiCompatApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getOpenaiCompat: builder.query<OpenaiCompatSettings, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['openai-compat'].get()),
      providesTags: ['OpenaiCompat']
    })
  })
});

export const { useGetOpenaiCompatQuery } = getOpenaiCompatApi;
