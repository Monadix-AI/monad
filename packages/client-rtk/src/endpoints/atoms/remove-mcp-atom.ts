import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { installMcpAtomApi } from './install-mcp-atom.ts';

export const removeMcpAtomApi = installMcpAtomApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    removeMcpAtom: builder.mutation<OkResponse, { name: string }>({
      queryFn: ({ name }: { name: string }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.mcp({ name }).delete()),
      invalidatesTags: ['InstalledMcp']
    })
  })
});

export const { useRemoveMcpAtomMutation } = removeMcpAtomApi;
