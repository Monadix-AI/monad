import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { frameworkAgentAdapter, listFrameworkAgentsApi } from './list-framework-agents.ts';
import { upsertFrameworkAgentApi } from './upsert-framework-agent.ts';

export const setFrameworkAgentEnabledApi = upsertFrameworkAgentApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setFrameworkAgentEnabled: builder.mutation<OkResponse, { name: string; enabled: boolean }>({
      queryFn: ({ name, enabled }, api: { extra: unknown }) =>
        runTreaty(() =>
          enabled
            ? clientOf(api).treaty.v1.settings['framework-agents']({ name }).enable.post()
            : clientOf(api).treaty.v1.settings['framework-agents']({ name }).disable.post()
        ),
      async onQueryStarted({ name, enabled }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listFrameworkAgentsApi.util.updateQueryData('listFrameworkAgents', undefined, (draft) => {
            const existing = draft.entities[name];
            if (existing) frameworkAgentAdapter.updateOne(draft, { id: name, changes: { enabled } });
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

export const { useSetFrameworkAgentEnabledMutation } = setFrameworkAgentEnabledApi;
