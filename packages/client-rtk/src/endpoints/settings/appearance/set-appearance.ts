import type { AppearanceSettings, SetAppearanceSettingsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getAppearanceApi } from './get-appearance.ts';

const setAppearanceApi = getAppearanceApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setAppearance: builder.mutation<AppearanceSettings, SetAppearanceSettingsRequest>({
      queryFn: (body: SetAppearanceSettingsRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.appearance.put(body)),
      invalidatesTags: ['AppearanceSettings']
    })
  })
});

export const { useSetAppearanceMutation } = setAppearanceApi;
