import type { AgentId, InstallMcpAtomRequest, InstallMcpAtomResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

type InstallAgentMcpArg = { agentId: AgentId } & InstallMcpAtomRequest;

const installAgentMcpApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    installAgentMcp: builder.mutation<InstallMcpAtomResponse, InstallAgentMcpArg>({
      queryFn: ({ agentId, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).mcp.post(body)),
      invalidatesTags: ['ImportInventory', 'McpServers']
    })
  })
});

export const { useInstallAgentMcpMutation } = installAgentMcpApi;
