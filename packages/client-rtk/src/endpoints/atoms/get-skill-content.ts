import type { GetSkillContentResponse } from '@monad/protocol';

import { getSkillContentResponseSchema } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { listInstalledSkillsApi } from './list-installed-skills.ts';

export const getSkillContentApi = listInstalledSkillsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getSkillContent: builder.query<GetSkillContentResponse, { name: string; file?: string; id?: string }>({
      queryFn: async ({ name, file, id }, api: { extra: unknown }) => {
        try {
          const params = new URLSearchParams();
          if (id) params.set('id', id);
          if (file) params.set('file', file);
          const qs = params.toString() ? `?${params}` : '';
          const res = await clientOf(api).fetch(`/v1/atoms/skills/${encodeURIComponent(name)}/content${qs}`);
          const body = await res.json();
          if (!res.ok) return { error: toError({ status: res.status, value: body }) };
          return { data: getSkillContentResponseSchema.parse(body) };
        } catch (err) {
          return { error: toError(err) };
        }
      },
      providesTags: (_result, _error, arg) => [{ type: 'InstalledSkills', id: arg.id ?? arg.name }]
    })
  })
});

export const { useGetSkillContentQuery, useLazyGetSkillContentQuery } = getSkillContentApi;
