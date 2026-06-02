import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMcpServersApi } from './list-mcp-servers.ts';

// Trigger the interactive OAuth flow for a config http oauth server. Blocks until the daemon-host
// browser / device flow completes (or times out), then the daemon reconnects the server; invalidating
// 'McpServers' refetches the status so the dot flips to connected.
const authorizeMcpServerApi = listMcpServersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    authorizeMcpServer: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty<OkResponse>(() => clientOf(api).treaty.v1.settings['mcp-servers']({ name }).authorize.post()),
      invalidatesTags: ['McpServers']
    })
  })
});

export const { useAuthorizeMcpServerMutation } = authorizeMcpServerApi;
