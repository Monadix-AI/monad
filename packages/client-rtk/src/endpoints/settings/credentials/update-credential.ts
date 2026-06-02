import type { AgentCredentialView, UpdateAgentCredentialRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listAgentCredentialsApi } from './list-credentials.ts';

type UpdateAgentCredentialArg = { credentialId: string; patch: UpdateAgentCredentialRequest };

export const updateAgentCredentialApi = listAgentCredentialsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateAgentCredential: builder.mutation<AgentCredentialView, UpdateAgentCredentialArg>({
      queryFn: ({ credentialId, patch }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.credentials({ id: credentialId }).patch(patch)),
      invalidatesTags: (_result, _error, { credentialId }) => [
        { type: 'AgentCredentials', id: 'LIST' },
        { type: 'AgentCredentials', id: credentialId }
      ]
    })
  })
});

export const { useUpdateAgentCredentialMutation } = updateAgentCredentialApi;
