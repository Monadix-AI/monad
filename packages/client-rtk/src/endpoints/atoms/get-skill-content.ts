import type { GetSkillContentResponse, SkillContentQuery } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listInstalledSkillsApi } from './list-installed-skills.ts';

export const getSkillContentApi = listInstalledSkillsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getSkillContent: builder.query<GetSkillContentResponse, { name: string; file?: string; id?: string }>({
      queryFn: async ({ name, file, id }, api: { extra: unknown }) => {
        const query: SkillContentQuery = {};
        if (id) query.id = id;
        if (file) query.file = file;
        return runTreaty(() =>
          clientOf(api)
            .treaty.v1.atoms.skills({ name })
            .content.get(Object.keys(query).length > 0 ? { query } : undefined)
        );
      },
      providesTags: (_result, _error, arg) => [{ type: 'InstalledSkills', id: arg.id ?? arg.name }]
    })
  })
});

export const { useGetSkillContentQuery, useLazyGetSkillContentQuery } = getSkillContentApi;
