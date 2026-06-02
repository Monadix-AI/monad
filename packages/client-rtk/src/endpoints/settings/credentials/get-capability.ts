import type { AgentCredentialCapability } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listAgentCredentialsApi } from './list-credentials.ts';

export const getAgentCredentialCapabilityApi = listAgentCredentialsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getAgentCredentialCapability: builder.query<AgentCredentialCapability, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.credentials.capability.get()),
      providesTags: [{ type: 'AgentCredentials', id: 'CAPABILITY' }]
    })
  })
});

export const { useGetAgentCredentialCapabilityQuery } = getAgentCredentialCapabilityApi;
