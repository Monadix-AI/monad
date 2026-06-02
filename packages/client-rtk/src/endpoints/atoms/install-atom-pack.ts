import type { InstallAtomPackRequest, InstallAtomPackResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listAtomPacksApi } from './list-atom-packs.ts';

export const installAtomPackApi = listAtomPacksApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    installAtomPack: builder.mutation<InstallAtomPackResponse, InstallAtomPackRequest>({
      queryFn: (body: InstallAtomPackRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.install.post(body)),
      // Only a committed install (no further consent needed) changes the installed set.
      invalidatesTags: (result) => (result?.needsConsent ? [] : ['Atoms'])
    })
  })
});

export const { useInstallAtomPackMutation } = installAtomPackApi;
