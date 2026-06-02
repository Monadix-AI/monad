import type { McpServerWrite, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMcpServersApi } from './list-mcp-servers.ts';

export const upsertMcpServerApi = listMcpServersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertMcpServer: builder.mutation<OkResponse, McpServerWrite>({
      queryFn: (server: McpServerWrite, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['mcp-servers']({ name: server.name }).put({ server })),
      invalidatesTags: ['McpServers']
    })
  })
});

export const { useUpsertMcpServerMutation } = upsertMcpServerApi;
