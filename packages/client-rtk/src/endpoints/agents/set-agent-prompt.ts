import type { AgentId, GetAgentPromptResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

type SetAgentPromptArg = { agentId: AgentId; prompt: string };

const setAgentPromptApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setAgentPrompt: builder.mutation<GetAgentPromptResponse, SetAgentPromptArg>({
      queryFn: ({ agentId, prompt }: SetAgentPromptArg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).prompt.put({ prompt })),
      // Invalidate both the prompt cache and the agent list/detail (hasPrompt may flip).
      invalidatesTags: (_res, _err, { agentId }) => [{ type: 'Agents', id: `prompt:${agentId}` }, 'Agents']
    })
  })
});

export const { useSetAgentPromptMutation } = setAgentPromptApi;
