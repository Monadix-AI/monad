import type { SkillsSettingsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

type SkillsSettingsTreaty = {
  skills: {
    get: () => Promise<{ data: SkillsSettingsResponse | null | undefined; error: unknown }>;
  };
};

export const getSkillsSettingsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getSkillsSettings: builder.query<SkillsSettingsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as SkillsSettingsTreaty;
        return runTreaty(() => settings.skills.get());
      },
      providesTags: ['SkillsSettings']
    })
  })
});

export const { useGetSkillsSettingsQuery } = getSkillsSettingsApi;
