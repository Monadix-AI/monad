import type { ImportSettingsPreview, ImportSettingsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

type SettingsImportTreaty = {
  import: {
    preview: {
      post: (
        body: ImportSettingsRequest
      ) => Promise<{ data: ImportSettingsPreview | null | undefined; error: unknown }>;
    };
  };
};

const previewSettingsImportApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    previewSettingsImport: builder.mutation<ImportSettingsPreview, ImportSettingsRequest>({
      queryFn: (body, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as SettingsImportTreaty;
        return runTreaty(() => settings.import.preview.post(body));
      }
    })
  })
});

export const { usePreviewSettingsImportMutation } = previewSettingsImportApi;
