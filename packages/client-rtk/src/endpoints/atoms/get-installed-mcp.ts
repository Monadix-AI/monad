import type { GetInstalledMcpAtomResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listInstalledMcpApi } from './list-installed-mcp.ts';

const getInstalledMcpApi = listInstalledMcpApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getInstalledMcp: builder.query<GetInstalledMcpAtomResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.mcp({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'InstalledMcp', id: name }]
    })
  })
});

export const { useGetInstalledMcpQuery } = getInstalledMcpApi;
