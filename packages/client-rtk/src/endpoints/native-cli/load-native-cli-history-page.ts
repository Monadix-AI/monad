import type { NativeCliHistoryPageRequest, NativeCliHistoryPageResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface NativeCliHistoryPageArgs extends NativeCliHistoryPageRequest {
  id: string;
}

export const loadNativeCliHistoryPageApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    loadNativeCliHistoryPage: builder.mutation<NativeCliHistoryPageResponse['page'], NativeCliHistoryPageArgs>({
      queryFn: ({ id, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-sessions']({ id })['history-page'].post(body),
          (raw) => raw.page
        )
    })
  })
});

export const { useLoadNativeCliHistoryPageMutation } = loadNativeCliHistoryPageApi;
