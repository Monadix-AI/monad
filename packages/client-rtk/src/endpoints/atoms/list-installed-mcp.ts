import type { ListInstalledMcpAtomsResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const listInstalledMcpApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listInstalledMcp: builder.query<ListInstalledMcpAtomsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.atoms.mcp.get()),
      providesTags: ['InstalledMcp']
    })
  })
});

export const { useListInstalledMcpQuery } = listInstalledMcpApi;
