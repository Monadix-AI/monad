import type {
  ImportSettingsApplyRequest,
  ImportSettingsApplyResult,
  ImportSettingsPreview,
  ImportSettingsRequest
} from '@monad/protocol';

import { importSettingsApplyResultSchema, importSettingsPreviewSchema } from '@monad/protocol';

import { clientOf, toError } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

async function postJson<T>(api: { extra: unknown }, path: string, body: unknown, parse: (value: unknown) => T) {
  try {
    const res = await clientOf(api).fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const responseBody = await res.json().catch(() => ({}));
    if (!res.ok) return { error: toError({ status: res.status, value: responseBody }) };
    return { data: parse(responseBody) };
  } catch (err) {
    return { error: toError(err) };
  }
}

const importSettingsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    previewSettingsImport: builder.mutation<ImportSettingsPreview, ImportSettingsRequest>({
      queryFn: (body, api: { extra: unknown }) =>
        postJson(api, '/v1/settings/import/preview', body, (value) => importSettingsPreviewSchema.parse(value))
    }),
    applySettingsImport: builder.mutation<ImportSettingsApplyResult, ImportSettingsApplyRequest>({
      queryFn: (body, api: { extra: unknown }) =>
        postJson(api, '/v1/settings/import/apply', body, (value) => importSettingsApplyResultSchema.parse(value)),
      invalidatesTags: ['Agents', 'McpServers', 'Providers', 'Profiles', 'Skills', 'CapabilityInventory']
    })
  })
});

export const { useApplySettingsImportMutation, usePreviewSettingsImportMutation } = importSettingsApi;
