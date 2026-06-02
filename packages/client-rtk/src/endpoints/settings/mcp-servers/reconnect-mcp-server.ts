import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMcpServersApi } from './list-mcp-servers.ts';

// Force one config server to (re)connect — retry a server that failed at boot. Invalidating
// 'McpServers' refetches the status so the dot flips to connected (or stays failed).
const reconnectMcpServerApi = listMcpServersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    reconnectMcpServer: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty<OkResponse>(() => clientOf(api).treaty.v1.settings['mcp-servers']({ name }).reconnect.post()),
      invalidatesTags: ['McpServers']
    })
  })
});

export const { useReconnectMcpServerMutation } = reconnectMcpServerApi;
