import type { AgentId, GetAgentPromptResponse, SetAgentPromptRequest } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const setAgentPromptApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setAgentPrompt: builder.mutation<GetAgentPromptResponse, { agentId: AgentId } & SetAgentPromptRequest>({
      queryFn: ({ agentId, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).prompt.put(body)),
      // Invalidate both the prompt cache and the agent list/detail (hasPrompt may flip).
      invalidatesTags: (_res, _err, { agentId }) => [{ type: 'Agents', id: `prompt:${agentId}` }, 'Agents']
    })
  })
});

export const { useSetAgentPromptMutation } = setAgentPromptApi;
