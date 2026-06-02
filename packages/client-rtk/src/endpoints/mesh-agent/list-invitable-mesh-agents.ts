import type { InvitableMeshAgent } from '@monad/protocol';

import { listInvitableMeshAgentsResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const listInvitableMeshAgentsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listInvitableMeshAgents: builder.query<InvitableMeshAgent[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh['invitable-agents'].get(),
          (raw) => listInvitableMeshAgentsResponseSchema.parse(raw).agents
        ),
      providesTags: ['InvitableMeshAgents']
    })
  })
});

export const { useListInvitableMeshAgentsQuery } = listInvitableMeshAgentsApi;
