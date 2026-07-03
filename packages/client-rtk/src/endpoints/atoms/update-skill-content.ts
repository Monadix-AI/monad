import type { CreateSkillResponse, SkillContentQuery } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getSkillContentApi } from './get-skill-content.ts';

const updateSkillContentApi = getSkillContentApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateSkillContent: builder.mutation<CreateSkillResponse, { name: string; id?: string; content: string }>({
      queryFn: async ({ name, id, content }, api: { extra: unknown }) => {
        const query: SkillContentQuery = {};
        if (id) query.id = id;
        return runTreaty(() =>
          clientOf(api)
            .treaty.v1.atoms.skills({ name })
            .content.put({ content }, Object.keys(query).length > 0 ? { query } : undefined)
        );
      },
      invalidatesTags: (_result, _error, arg) => [
        'InstalledSkills',
        'Skills',
        { type: 'InstalledSkills', id: arg.id ?? arg.name }
      ]
    })
  })
});

export const { useUpdateSkillContentMutation } = updateSkillContentApi;
