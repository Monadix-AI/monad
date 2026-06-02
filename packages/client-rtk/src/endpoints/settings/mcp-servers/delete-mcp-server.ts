import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMcpServersApi, mcpServerAdapter } from './list-mcp-servers.ts';
import { upsertMcpServerApi } from './upsert-mcp-server.ts';

const deleteMcpServerApi = upsertMcpServerApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteMcpServer: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['mcp-servers']({ name }).delete()),
      async onQueryStarted(name, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listMcpServersApi.util.updateQueryData('listMcpServers', undefined, (draft) => {
            mcpServerAdapter.removeOne(draft, name);
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

export const { useDeleteMcpServerMutation } = deleteMcpServerApi;
