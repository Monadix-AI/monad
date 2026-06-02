import type { DeleteAgentCredentialResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listAgentCredentialsApi } from './list-credentials.ts';

export const deleteAgentCredentialApi = listAgentCredentialsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteAgentCredential: builder.mutation<DeleteAgentCredentialResponse, string>({
      queryFn: (credentialId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.credentials({ id: credentialId }).delete()),
      invalidatesTags: (result, _error, credentialId) => [
        { type: 'AgentCredentials', id: 'LIST' },
        { type: 'AgentCredentials', id: credentialId },
        ...(result?.affectedAgentIds.map((agentId) => ({ type: 'Agents' as const, id: agentId })) ?? []),
        'Agents'
      ]
    })
  })
});

export const { useDeleteAgentCredentialMutation } = deleteAgentCredentialApi;
