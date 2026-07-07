import type { ExternalAgentView, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { externalAgentAdapter, listExternalAgentsApi } from './list-external-agents.ts';

export const upsertExternalAgentApi = listExternalAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertExternalAgent: builder.mutation<OkResponse, ExternalAgentView>({
      queryFn: (agent: ExternalAgentView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['external-agents']({ name: agent.name }).put({ agent })),
      async onQueryStarted(agent, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listExternalAgentsApi.util.updateQueryData('listExternalAgents', undefined, (draft) => {
            externalAgentAdapter.upsertOne(draft, agent);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['ExternalAgents']
    })
  })
});

export const { useUpsertExternalAgentMutation } = upsertExternalAgentApi;
