import type { FrameworkAgentView, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { frameworkAgentAdapter, listFrameworkAgentsApi } from './list-framework-agents.ts';

export const upsertFrameworkAgentApi = listFrameworkAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertFrameworkAgent: builder.mutation<OkResponse, FrameworkAgentView>({
      queryFn: (agent: FrameworkAgentView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['framework-agents'].put({ agent })),
      async onQueryStarted(agent, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listFrameworkAgentsApi.util.updateQueryData('listFrameworkAgents', undefined, (draft) => {
            frameworkAgentAdapter.upsertOne(draft, agent);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['FrameworkAgents']
    })
  })
});

export const { useUpsertFrameworkAgentMutation } = upsertFrameworkAgentApi;
