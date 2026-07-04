import type {
  ListNativeCliSettingsImportCandidatesResponse,
  NativeCliSettingsImportApplyRequest,
  NativeCliSettingsImportApplyResult,
  NativeCliSettingsImportCandidate,
  NativeCliSettingsImportPreview,
  NativeCliSettingsImportPreviewRequest
} from '@monad/protocol';

import {
  listNativeCliSettingsImportCandidatesResponseSchema,
  nativeCliSettingsImportApplyResultSchema,
  nativeCliSettingsImportPreviewSchema
} from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

type NativeCliSettingsImportTreaty = {
  'native-cli-agents': (args: { name: string }) => {
    import: {
      candidates: {
        get: () => Promise<{ data: ListNativeCliSettingsImportCandidatesResponse | null | undefined; error: unknown }>;
      };
      preview: {
        post: (
          body: NativeCliSettingsImportPreviewRequest
        ) => Promise<{ data: NativeCliSettingsImportPreview | null | undefined; error: unknown }>;
      };
      apply: {
        post: (
          body: NativeCliSettingsImportApplyRequest
        ) => Promise<{ data: NativeCliSettingsImportApplyResult | null | undefined; error: unknown }>;
      };
    };
  };
};

const nativeCliSettingsImportApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listNativeCliSettingsImportCandidates: builder.query<NativeCliSettingsImportCandidate[], string>({
      queryFn: (name, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as NativeCliSettingsImportTreaty;
        return runTreaty(
          () => settings['native-cli-agents']({ name }).import.candidates.get(),
          (raw) => listNativeCliSettingsImportCandidatesResponseSchema.parse(raw).candidates
        );
      }
    }),
    previewNativeCliSettingsImport: builder.mutation<
      NativeCliSettingsImportPreview,
      { name: string } & NativeCliSettingsImportPreviewRequest
    >({
      queryFn: ({ name, ...body }, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as NativeCliSettingsImportTreaty;
        return runTreaty(
          () => settings['native-cli-agents']({ name }).import.preview.post(body),
          (raw) => nativeCliSettingsImportPreviewSchema.parse(raw)
        );
      }
    }),
    applyNativeCliSettingsImport: builder.mutation<
      NativeCliSettingsImportApplyResult,
      { name: string } & NativeCliSettingsImportApplyRequest
    >({
      queryFn: ({ name, ...body }, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as NativeCliSettingsImportTreaty;
        return runTreaty(
          () => settings['native-cli-agents']({ name }).import.apply.post(body),
          (raw) => nativeCliSettingsImportApplyResultSchema.parse(raw)
        );
      },
      invalidatesTags: ['NativeCliAgents']
    })
  })
});

export const {
  useApplyNativeCliSettingsImportMutation,
  useListNativeCliSettingsImportCandidatesQuery,
  usePreviewNativeCliSettingsImportMutation
} = nativeCliSettingsImportApi;
