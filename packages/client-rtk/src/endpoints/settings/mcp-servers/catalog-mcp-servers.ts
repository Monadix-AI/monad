import type { McpCatalogEntry } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

// Curated directory of popular MCP servers for one-click add. Static reference data — no cache tag,
// fetched once and reused; the picker maps an entry into a pre-filled add form.
const listMcpCatalogApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMcpCatalog: builder.query<McpCatalogEntry[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['mcp-servers'].catalog.get(),
          (raw) => raw.entries
        )
    })
  })
});

export const { useListMcpCatalogQuery } = listMcpCatalogApi;
