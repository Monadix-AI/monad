import type { GetMcpTaskResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMcpServersApi } from './list-mcp-servers.ts';

const cancelMcpTaskApi = listMcpServersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    cancelMcpTask: builder.mutation<GetMcpTaskResponse, { name: string; taskId: string }>({
      queryFn: ({ name, taskId }, api: { extra: unknown }) =>
        runTreaty<GetMcpTaskResponse>(() =>
          clientOf(api).treaty.v1.settings['mcp-servers']({ name }).tasks({ taskId }).cancel.post()
        ),
      invalidatesTags: ['McpServers']
    })
  })
});

export const { useCancelMcpTaskMutation } = cancelMcpTaskApi;
