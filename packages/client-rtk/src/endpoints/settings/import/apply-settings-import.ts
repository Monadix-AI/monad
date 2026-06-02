import type { ImportSettingsApplyRequest, ImportSettingsApplyResult } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

type SettingsImportTreaty = {
  import: {
    apply: {
      post: (
        body: ImportSettingsApplyRequest
      ) => Promise<{ data: ImportSettingsApplyResult | null | undefined; error: unknown }>;
    };
  };
};

const applySettingsImportApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    applySettingsImport: builder.mutation<ImportSettingsApplyResult, ImportSettingsApplyRequest>({
      queryFn: (body, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as SettingsImportTreaty;
        return runTreaty(() => settings.import.apply.post(body));
      },
      invalidatesTags: [
        'Agents',
        'McpServers',
        'Providers',
        'Profiles',
        'Default',
        'Roles',
        'Credentials',
        'Skills',
        'SkillsSettings',
        'InstalledSkills',
        'SandboxSettings',
        'ToolBackends'
      ]
    })
  })
});

export const { useApplySettingsImportMutation } = applySettingsImportApi;
