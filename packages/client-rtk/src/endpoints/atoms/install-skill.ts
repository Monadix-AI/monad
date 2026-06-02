import type { InstallSkillResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listInstalledSkillsApi } from './list-installed-skills.ts';

// consent/overwrite are optional for callers; filled before the wire call (the daemon body schema
// marks them required via zod `.default()`, so the treaty client expects concrete values).
export type InstallSkillArg = { source: string; consent?: boolean; overwrite?: boolean };

export const installSkillApi = listInstalledSkillsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    installSkill: builder.mutation<InstallSkillResponse, InstallSkillArg>({
      queryFn: (body: InstallSkillArg, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.atoms.skills.install.post({
            source: body.source,
            consent: body.consent ?? false,
            overwrite: body.overwrite ?? false
          })
        ),
      // Only a committed install (no further consent needed) changes the installed set.
      invalidatesTags: (result) => (result?.needsConsent ? [] : ['InstalledSkills', 'Skills'])
    })
  })
});

export const { useInstallSkillMutation } = installSkillApi;
