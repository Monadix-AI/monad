import type { InstallMcpAtomRequest, InstallMcpAtomResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listInstalledMcpApi } from './list-installed-mcp.ts';

export const installMcpAtomApi = listInstalledMcpApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    installMcpAtom: builder.mutation<InstallMcpAtomResponse, InstallMcpAtomRequest>({
      queryFn: (body: InstallMcpAtomRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.mcp.install.post(body)),
      invalidatesTags: (result) => (result?.needsConsent ? [] : ['InstalledMcp'])
    })
  })
});

export const { useInstallMcpAtomMutation } = installMcpAtomApi;
