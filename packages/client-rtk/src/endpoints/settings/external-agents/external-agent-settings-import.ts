import type {
  ExternalAgentSettingsImportApplyRequest,
  ExternalAgentSettingsImportApplyResult,
  ExternalAgentSettingsImportCandidate,
  ExternalAgentSettingsImportPreview,
  ExternalAgentSettingsImportPreviewRequest,
  ListExternalAgentSettingsImportCandidatesResponse
} from '@monad/protocol';

import {
  externalAgentSettingsImportApplyResultSchema,
  externalAgentSettingsImportPreviewSchema,
  listExternalAgentSettingsImportCandidatesResponseSchema
} from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

type ExternalAgentSettingsImportTreaty = {
  'external-agents': (args: { name: string }) => {
    import: {
      candidates: {
        get: () => Promise<{
          data: ListExternalAgentSettingsImportCandidatesResponse | null | undefined;
          error: unknown;
        }>;
      };
      preview: {
        post: (
          body: ExternalAgentSettingsImportPreviewRequest
        ) => Promise<{ data: ExternalAgentSettingsImportPreview | null | undefined; error: unknown }>;
      };
      apply: {
        post: (
          body: ExternalAgentSettingsImportApplyRequest
        ) => Promise<{ data: ExternalAgentSettingsImportApplyResult | null | undefined; error: unknown }>;
      };
    };
  };
};

const externalAgentSettingsImportApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listExternalAgentSettingsImportCandidates: builder.query<ExternalAgentSettingsImportCandidate[], string>({
      queryFn: (name, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as ExternalAgentSettingsImportTreaty;
        return runTreaty(
          () => settings['external-agents']({ name }).import.candidates.get(),
          (raw) => listExternalAgentSettingsImportCandidatesResponseSchema.parse(raw).candidates
        );
      }
    }),
    previewExternalAgentSettingsImport: builder.mutation<
      ExternalAgentSettingsImportPreview,
      { name: string } & ExternalAgentSettingsImportPreviewRequest
    >({
      queryFn: ({ name, ...body }, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as ExternalAgentSettingsImportTreaty;
        return runTreaty(
          () => settings['external-agents']({ name }).import.preview.post(body),
          (raw) => externalAgentSettingsImportPreviewSchema.parse(raw)
        );
      }
    }),
    applyExternalAgentSettingsImport: builder.mutation<
      ExternalAgentSettingsImportApplyResult,
      { name: string } & ExternalAgentSettingsImportApplyRequest
    >({
      queryFn: ({ name, ...body }, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as ExternalAgentSettingsImportTreaty;
        return runTreaty(
          () => settings['external-agents']({ name }).import.apply.post(body),
          (raw) => externalAgentSettingsImportApplyResultSchema.parse(raw)
        );
      },
      invalidatesTags: ['ExternalAgents']
    })
  })
});

export const {
  useApplyExternalAgentSettingsImportMutation,
  useListExternalAgentSettingsImportCandidatesQuery,
  usePreviewExternalAgentSettingsImportMutation
} = externalAgentSettingsImportApi;
