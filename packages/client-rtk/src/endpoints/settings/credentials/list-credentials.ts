import type { ListAgentCredentialsResponse } from '@monad/protocol';

import { apiSlice } from '../../../api-slice.ts';
import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';

export const listAgentCredentialsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listAgentCredentials: builder.query<ListAgentCredentialsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.credentials.get()),
      providesTags: (result) => [
        { type: 'AgentCredentials', id: 'LIST' },
        ...(result?.credentials.map((credential) => ({ type: 'AgentCredentials' as const, id: credential.id })) ?? [])
      ]
    })
  })
});

export const { useListAgentCredentialsQuery } = listAgentCredentialsApi;
