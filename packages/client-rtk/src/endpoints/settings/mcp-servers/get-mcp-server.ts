import type { GetMcpServerResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMcpServersApi } from './list-mcp-servers.ts';

const getMcpServerApi = listMcpServersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMcpServer: builder.query<GetMcpServerResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['mcp-servers']({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'McpServers', id: name }]
    })
  })
});

export const { useGetMcpServerQuery } = getMcpServerApi;
