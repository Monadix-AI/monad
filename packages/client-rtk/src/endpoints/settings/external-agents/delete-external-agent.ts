import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { externalAgentAdapter, listExternalAgentsApi } from './list-external-agents.ts';
import { upsertExternalAgentApi } from './upsert-external-agent.ts';

const deleteExternalAgentApi = upsertExternalAgentApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteExternalAgent: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['external-agents']({ name }).delete()),
      async onQueryStarted(name, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listExternalAgentsApi.util.updateQueryData('listExternalAgents', undefined, (draft) => {
            externalAgentAdapter.removeOne(draft, name);
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

export const { useDeleteExternalAgentMutation } = deleteExternalAgentApi;
