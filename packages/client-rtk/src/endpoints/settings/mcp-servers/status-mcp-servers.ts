import type { McpServerStatus } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

// Live connection health (disabled / starting / ready / failed + tools) across config, presets, file/pack
// atoms, and obscura. Tagged 'McpServers' so explicit refreshes and mutations can reconcile it without
// a timer loop in the panel.
export const listMcpServerStatusApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMcpServerStatus: builder.query<McpServerStatus[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['mcp-servers'].status.get(),
          (raw) => raw.servers
        ),
      providesTags: ['McpServers']
    })
  })
});

export const { useLazyListMcpServerStatusQuery, useListMcpServerStatusQuery } = listMcpServerStatusApi;
