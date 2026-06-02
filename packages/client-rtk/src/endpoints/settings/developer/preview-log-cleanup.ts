import type { LogCleanupPreview, PreviewLogCleanupRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const LOG_CLEANUP_PREVIEW_TIMEOUT_MS = 5_000;

const previewLogCleanupApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    previewLogCleanup: builder.mutation<LogCleanupPreview, PreviewLogCleanupRequest>({
      async queryFn(body: PreviewLogCleanupRequest, api: { extra: unknown; signal: AbortSignal }) {
        const controller = new AbortController();
        const abort = () => controller.abort(api.signal.reason);
        if (api.signal.aborted) abort();
        else api.signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(
          () => controller.abort(new Error('log cleanup preview timed out')),
          LOG_CLEANUP_PREVIEW_TIMEOUT_MS
        );
        try {
          return await runTreaty(() =>
            clientOf(api).treaty.v1.settings.developer.logs.preview.post(body, {
              fetch: { signal: controller.signal }
            })
          );
        } finally {
          clearTimeout(timeout);
          api.signal.removeEventListener('abort', abort);
        }
      }
    })
  })
});

export const { usePreviewLogCleanupMutation } = previewLogCleanupApi;
