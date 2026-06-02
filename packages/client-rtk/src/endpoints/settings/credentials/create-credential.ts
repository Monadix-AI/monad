import type { AgentCredentialView, CreateAgentCredentialRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listAgentCredentialsApi } from './list-credentials.ts';

export const createAgentCredentialApi = listAgentCredentialsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createAgentCredential: builder.mutation<AgentCredentialView, CreateAgentCredentialRequest>({
      queryFn: (body, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.credentials.post(body)),
      invalidatesTags: [{ type: 'AgentCredentials', id: 'LIST' }]
    })
  })
});

export const { useCreateAgentCredentialMutation } = createAgentCredentialApi;
