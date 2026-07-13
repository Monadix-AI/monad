import type { ActivateSandboxBackendRequest, SandboxActivationResult } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const activateSandboxApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    activateSandbox: builder.mutation<SandboxActivationResult, ActivateSandboxBackendRequest>({
      queryFn: (body, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.sandbox.activate.put(body)),
      invalidatesTags: ['SandboxSettings']
    })
  })
});

export const { useActivateSandboxMutation } = activateSandboxApi;
