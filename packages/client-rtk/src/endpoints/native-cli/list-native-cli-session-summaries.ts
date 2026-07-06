import type { ListNativeCliRuntimesQuery, ListNativeCliRuntimesResponse, NativeCliSessionView } from '@monad/protocol';

import { listNativeCliRuntimesResponseSchema } from '@monad/protocol';

import { type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { nativeCliSessionAdapter } from './list-native-cli-sessions.ts';

type ListNativeCliSessionSummariesResult = NormalizedCursorPaginateResponse<
  NativeCliSessionView,
  'sessions',
  ListNativeCliRuntimesResponse
>;

const listNativeCliSessionSummariesApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listNativeCliSessionSummaries: builder.query<
      ListNativeCliSessionSummariesResult,
      ListNativeCliRuntimesQuery | undefined
    >({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-session-summaries'].get({ query: arg ?? {} }),
          (raw) => {
            const parsed = listNativeCliRuntimesResponseSchema.parse(raw);
            return {
              ...parsed,
              sessions: nativeCliSessionAdapter.setAll(nativeCliSessionAdapter.getInitialState(), parsed.sessions)
            };
          }
        ),
      providesTags: ['NativeCliSessions']
    })
  })
});

export const { useListNativeCliSessionSummariesQuery } = listNativeCliSessionSummariesApi;
