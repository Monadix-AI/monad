import type { McpServerView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const mcpServerAdapter = createEntityAdapter<McpServerView, string>({ selectId: (s) => s.name });
export const mcpServerSelectors = mcpServerAdapter.getSelectors();

export const listMcpServersApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMcpServers: builder.query<EntityState<McpServerView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['mcp-servers'].get(),
          (raw) => mcpServerAdapter.setAll(mcpServerAdapter.getInitialState(), raw.servers)
        ),
      providesTags: ['McpServers']
    })
  })
});

export const { useListMcpServersQuery } = listMcpServersApi;
