import type { NativeCliAgentView, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listNativeCliAgentsApi, nativeCliAgentAdapter } from './list-native-cli-agents.ts';

export const upsertNativeCliAgentApi = listNativeCliAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertNativeCliAgent: builder.mutation<OkResponse, NativeCliAgentView>({
      queryFn: (agent: NativeCliAgentView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['native-cli-agents'].put({ agent })),
      async onQueryStarted(agent, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listNativeCliAgentsApi.util.updateQueryData('listNativeCliAgents', undefined, (draft) => {
            nativeCliAgentAdapter.upsertOne(draft, agent);
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

export const { useUpsertNativeCliAgentMutation } = upsertNativeCliAgentApi;
