import type { InstallMcpAtomResponse, InstallMcpBinaryRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { removeMcpAtomApi } from './remove-mcp-atom.ts';

// autoApproveTools/consent are optional for callers; filled before the wire call (the daemon body
// schema marks them required via zod `.default()`).
type InstallMcpBinaryArg = Omit<InstallMcpBinaryRequest, 'autoApproveTools' | 'consent'> & {
  autoApproveTools?: string[];
  consent?: boolean;
};

const installMcpBinaryApi = removeMcpAtomApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    installMcpBinary: builder.mutation<InstallMcpAtomResponse, InstallMcpBinaryArg>({
      queryFn: (body: InstallMcpBinaryArg, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.atoms.mcp['install-binary'].post({
            ...body,
            autoApproveTools: body.autoApproveTools ?? [],
            consent: body.consent ?? false
          })
        ),
      invalidatesTags: (result) => (result?.needsConsent ? [] : ['InstalledMcp'])
    })
  })
});

export const { useInstallMcpBinaryMutation } = installMcpBinaryApi;
