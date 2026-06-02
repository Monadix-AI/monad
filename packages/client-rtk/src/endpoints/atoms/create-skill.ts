import type { CreateSkillRequest, CreateSkillResponse } from '@monad/protocol';
import type { SkillMutationTarget } from './install-skill.ts';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { installSkillApi } from './install-skill.ts';

type CreateSkillArg = Omit<CreateSkillRequest, 'target'> & { target?: SkillMutationTarget };

const createSkillApi = installSkillApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createSkill: builder.mutation<CreateSkillResponse, CreateSkillArg>({
      queryFn: (body, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.atoms.skills.post({
            name: body.name,
            content: body.content,
            target: body.target
          })
        ),
      invalidatesTags: ['InstalledSkills', 'Skills', 'SlashCommands', 'ImportInventory']
    })
  })
});

export const { useCreateSkillMutation } = createSkillApi;
