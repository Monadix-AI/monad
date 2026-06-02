import type { ListSkillsQueryInput, ListSkillsResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const skillsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listSkills: builder.query<ListSkillsResponse, ListSkillsQueryInput | undefined>({
      queryFn: async (arg, api: { extra: unknown }) => {
        const query: ListSkillsQueryInput = arg ?? { scope: 'runtime' };
        const res = await runTreaty(() =>
          clientOf(api).treaty.v1.skills.get({ query: query as unknown as { scope: string } })
        );
        if ('error' in res) return res;
        const data = res.data as Partial<ListSkillsResponse> & Pick<ListSkillsResponse, 'skills'>;
        return { data: { ...data, skillInstances: data.skillInstances ?? [] } };
      },
      providesTags: ['Skills']
    })
  })
});

export const { useListSkillsQuery } = skillsApi;
