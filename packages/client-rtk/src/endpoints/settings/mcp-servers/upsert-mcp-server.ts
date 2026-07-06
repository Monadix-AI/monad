import type { McpServerView, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMcpServersApi, mcpServerAdapter } from './list-mcp-servers.ts';

export const upsertMcpServerApi = listMcpServersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertMcpServer: builder.mutation<OkResponse, McpServerView>({
      queryFn: (server: McpServerView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['mcp-servers']({ name: server.name }).put({ server })),
      async onQueryStarted(server, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listMcpServersApi.util.updateQueryData('listMcpServers', undefined, (draft) => {
            mcpServerAdapter.upsertOne(draft, server);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['McpServers']
    })
  })
});

export const { useUpsertMcpServerMutation } = upsertMcpServerApi;
