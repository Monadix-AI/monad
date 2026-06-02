import type { SandboxSettingsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const getSandboxApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getSandbox: builder.query<SandboxSettingsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.sandbox.get()),
      providesTags: ['SandboxSettings']
    })
  })
});

export const { useGetSandboxQuery } = getSandboxApi;
