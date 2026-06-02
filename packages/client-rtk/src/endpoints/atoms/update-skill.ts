import type { InstallSkillResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { installSkillApi } from './install-skill.ts';

const updateSkillApi = installSkillApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateSkill: builder.mutation<InstallSkillResponse, { name: string; consent?: boolean }>({
      queryFn: ({ name, consent }: { name: string; consent?: boolean }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1.atoms.skills({ name })
            .update.post({ consent: consent ?? false })
        ),
      invalidatesTags: (result) => (result?.needsConsent ? [] : ['InstalledSkills'])
    })
  })
});

export const { useUpdateSkillMutation } = updateSkillApi;
