import type { InstallSkillResponse, UploadSkillQuery } from '@monad/protocol';

import { httpErrorSchema, installSkillResponseSchema } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { listInstalledSkillsApi } from './list-installed-skills.ts';

type UploadSkillArg = { filename: string; body: BodyInit; overwrite?: boolean; contentType?: string };
const errorResponseSchema = httpErrorSchema.partial().nullable();

const uploadSkillApi = listInstalledSkillsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    uploadSkill: builder.mutation<InstallSkillResponse, UploadSkillArg>({
      queryFn: async (body, api: { extra: unknown }) => {
        const query: UploadSkillQuery = { filename: body.filename, overwrite: String(body.overwrite ?? false) };
        const params = new URLSearchParams(query);
        // Intentional raw fetch escape hatch: this endpoint uploads arbitrary BodyInit/octet-stream bytes,
        // while the treaty surfaces are JSON-shaped.
        const res = await clientOf(api).fetch(`/v1/atoms/skills/upload?${params}`, {
          method: 'POST',
          headers: { 'content-type': body.contentType ?? 'application/octet-stream' },
          body: body.body
        });
        if (!res.ok) {
          const parsed = errorResponseSchema.parse(await res.json().catch(() => null));
          return { error: { status: res.status, code: parsed?.code, message: parsed?.error ?? res.statusText } };
        }
        return { data: installSkillResponseSchema.parse(await res.json()) };
      },
      invalidatesTags: ['InstalledSkills', 'Skills', 'SlashCommands']
    })
  })
});

export const { useUploadSkillMutation } = uploadSkillApi;
