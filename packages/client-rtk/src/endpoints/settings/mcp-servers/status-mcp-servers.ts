import type { McpServerStatus } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

// Live connection health (connected / disabled / failed + tools) across config, presets, file/pack
// atoms, and obscura. Tagged 'McpServers' so a save/delete refetches it; poll from the panel for the
// brief window between a config write and the daemon's debounced reconnect.
const listMcpServerStatusApi = sessionsApi.injectEndpoints({
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

export const { useListMcpServerStatusQuery } = listMcpServerStatusApi;
