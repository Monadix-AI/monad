import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { frameworkAgentAdapter, listFrameworkAgentsApi } from './list-framework-agents.ts';
import { setFrameworkAgentEnabledApi } from './set-framework-agent-enabled.ts';

const removeFrameworkAgentApi = setFrameworkAgentEnabledApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    removeFrameworkAgent: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['framework-agents']({ name }).delete()),
      async onQueryStarted(name, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listFrameworkAgentsApi.util.updateQueryData('listFrameworkAgents', undefined, (draft) => {
            frameworkAgentAdapter.removeOne(draft, name);
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

export const { useRemoveFrameworkAgentMutation } = removeFrameworkAgentApi;
