import type { HooksSettingsResponse, SetHooksSettingsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getHooksApi } from './get-hooks.ts';

const setHooksApi = getHooksApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setHooks: builder.mutation<HooksSettingsResponse, SetHooksSettingsRequest>({
      queryFn: (body: SetHooksSettingsRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.hooks.put(body)),
      invalidatesTags: ['Hooks']
    })
  })
});

export const { useSetHooksMutation } = setHooksApi;
