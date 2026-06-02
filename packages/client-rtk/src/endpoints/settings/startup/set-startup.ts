import type { SetStartupSettingsRequest, StartupSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const setStartupApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setStartup: builder.mutation<StartupSettings, SetStartupSettingsRequest>({
      queryFn: (body: SetStartupSettingsRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.startup.put(body)),
      invalidatesTags: ['StartupSettings']
    })
  })
});

export const { useSetStartupMutation } = setStartupApi;
