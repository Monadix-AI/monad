import type { AppearanceSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getAppearanceApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getAppearance: builder.query<AppearanceSettings, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.appearance.get()),
      providesTags: ['AppearanceSettings']
    })
  })
});

export const { useGetAppearanceQuery } = getAppearanceApi;
