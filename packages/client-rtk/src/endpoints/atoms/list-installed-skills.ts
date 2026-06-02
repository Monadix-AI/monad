import type { ListInstalledSkillsResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const listInstalledSkillsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listInstalledSkills: builder.query<ListInstalledSkillsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.atoms.skills.get()),
      providesTags: ['InstalledSkills']
    })
  })
});

export const { useListInstalledSkillsQuery } = listInstalledSkillsApi;
