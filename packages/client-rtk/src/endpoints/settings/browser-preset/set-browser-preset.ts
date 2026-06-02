import type { BrowserPresetResponse, SetBrowserPresetRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getBrowserPresetApi } from './get-browser-preset.ts';

const setBrowserPresetApi = getBrowserPresetApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setBrowserPreset: builder.mutation<BrowserPresetResponse, SetBrowserPresetRequest>({
      queryFn: (body: SetBrowserPresetRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['browser-preset'].put(body)),
      invalidatesTags: ['BrowserPreset']
    })
  })
});

export const { useSetBrowserPresetMutation } = setBrowserPresetApi;
