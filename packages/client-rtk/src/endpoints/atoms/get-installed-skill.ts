import type { GetInstalledSkillResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listInstalledSkillsApi } from './list-installed-skills.ts';

const getInstalledSkillApi = listInstalledSkillsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getInstalledSkill: builder.query<GetInstalledSkillResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.skills({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'InstalledSkills', id: name }]
    })
  })
});

export const { useGetInstalledSkillQuery } = getInstalledSkillApi;
