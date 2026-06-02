import type { BrowserPresetResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getBrowserPresetApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getBrowserPreset: builder.query<BrowserPresetResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['browser-preset'].get()),
      providesTags: ['BrowserPreset']
    })
  })
});

export const { useGetBrowserPresetQuery } = getBrowserPresetApi;
