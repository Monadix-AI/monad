import type { LogCleanupResult } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const clearLogsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    clearLogs: builder.mutation<LogCleanupResult, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.developer.logs.delete())
    })
  })
});

export const { useClearLogsMutation } = clearLogsApi;
