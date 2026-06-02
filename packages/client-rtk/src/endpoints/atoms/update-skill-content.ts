import type { CreateSkillResponse } from '@monad/protocol';

import { createSkillResponseSchema } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { getSkillContentApi } from './get-skill-content.ts';

const updateSkillContentApi = getSkillContentApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateSkillContent: builder.mutation<CreateSkillResponse, { name: string; id?: string; content: string }>({
      queryFn: async ({ name, id, content }, api: { extra: unknown }) => {
        try {
          const qs = id ? `?id=${encodeURIComponent(id)}` : '';
          const res = await clientOf(api).fetch(`/v1/atoms/skills/${encodeURIComponent(name)}/content${qs}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content })
          });
          const body = await res.json();
          if (!res.ok) return { error: toError({ status: res.status, value: body }) };
          return { data: createSkillResponseSchema.parse(body) };
        } catch (err) {
          return { error: toError(err) };
        }
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
