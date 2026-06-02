import type { SandboxSettingsResponse, SetSandboxSettingsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const setSandboxApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setSandbox: builder.mutation<SandboxSettingsResponse, SetSandboxSettingsRequest>({
      queryFn: (body: SetSandboxSettingsRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.sandbox.put(body)),
      invalidatesTags: ['SandboxSettings']
    })
  })
});

export const { useSetSandboxMutation } = setSandboxApi;
