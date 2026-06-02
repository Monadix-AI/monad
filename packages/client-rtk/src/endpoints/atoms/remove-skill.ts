import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { installSkillApi } from './install-skill.ts';

export const removeSkillApi = installSkillApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    removeSkill: builder.mutation<OkResponse, { name: string }>({
      queryFn: ({ name }: { name: string }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.skills({ name }).delete()),
      invalidatesTags: ['InstalledSkills']
    })
  })
});

export const { useRemoveSkillMutation } = removeSkillApi;
