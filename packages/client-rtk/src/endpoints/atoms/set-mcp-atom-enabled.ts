import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { removeMcpAtomApi } from './remove-mcp-atom.ts';

const setMcpAtomEnabledApi = removeMcpAtomApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setMcpAtomEnabled: builder.mutation<OkResponse, { name: string; enabled: boolean }>({
      queryFn: ({ name, enabled }: { name: string; enabled: boolean }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.mcp({ name })[enabled ? 'enable' : 'disable'].post()),
      invalidatesTags: ['InstalledMcp']
    })
  })
});

export const { useSetMcpAtomEnabledMutation } = setMcpAtomEnabledApi;
