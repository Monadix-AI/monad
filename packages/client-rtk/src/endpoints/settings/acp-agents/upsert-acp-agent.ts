import type { AcpAgentView, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { acpAgentAdapter, listAcpAgentsApi } from './list-acp-agents.ts';

export const upsertAcpAgentApi = listAcpAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertAcpAgent: builder.mutation<OkResponse, AcpAgentView>({
      queryFn: (agent: AcpAgentView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['acp-agents'].put({ agent })),
      async onQueryStarted(agent, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listAcpAgentsApi.util.updateQueryData('listAcpAgents', undefined, (draft) => {
            acpAgentAdapter.upsertOne(draft, agent);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['AcpAgents']
    })
  })
});

export const { useUpsertAcpAgentMutation } = upsertAcpAgentApi;
