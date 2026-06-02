import type { DeveloperSettings, SetDeveloperSettingsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const setDeveloperApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setDeveloper: builder.mutation<DeveloperSettings, SetDeveloperSettingsRequest>({
      queryFn: (body: SetDeveloperSettingsRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.developer.put(body)),
      invalidatesTags: ['DeveloperSettings']
    })
  })
});

export const { useSetDeveloperMutation } = setDeveloperApi;
