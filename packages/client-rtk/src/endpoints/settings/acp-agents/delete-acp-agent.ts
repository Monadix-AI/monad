import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { acpAgentAdapter, listAcpAgentsApi } from './list-acp-agents.ts';
import { upsertAcpAgentApi } from './upsert-acp-agent.ts';

const deleteAcpAgentApi = upsertAcpAgentApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteAcpAgent: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['acp-agents']({ name }).delete()),
      async onQueryStarted(name, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listAcpAgentsApi.util.updateQueryData('listAcpAgents', undefined, (draft) => {
            acpAgentAdapter.removeOne(draft, name);
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

export const { useDeleteAcpAgentMutation } = deleteAcpAgentApi;
