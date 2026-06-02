import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listNativeCliAgentsApi, nativeCliAgentAdapter } from './list-native-cli-agents.ts';
import { upsertNativeCliAgentApi } from './upsert-native-cli-agent.ts';

const deleteNativeCliAgentApi = upsertNativeCliAgentApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteNativeCliAgent: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['native-cli-agents']({ name }).delete()),
      async onQueryStarted(name, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listNativeCliAgentsApi.util.updateQueryData('listNativeCliAgents', undefined, (draft) => {
            nativeCliAgentAdapter.removeOne(draft, name);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['NativeCliAgents']
    })
  })
});

export const { useDeleteNativeCliAgentMutation } = deleteNativeCliAgentApi;
