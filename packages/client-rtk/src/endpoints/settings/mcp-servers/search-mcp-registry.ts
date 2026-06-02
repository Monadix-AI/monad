import type { SearchMcpRegistryResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const searchMcpRegistryApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    searchMcpRegistry: builder.query<SearchMcpRegistryResponse, string>({
      queryFn: (q, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['mcp-servers'].registry.search.get({ query: { q } }))
    })
  })
});

export const { useSearchMcpRegistryQuery, useLazySearchMcpRegistryQuery } = searchMcpRegistryApi;
