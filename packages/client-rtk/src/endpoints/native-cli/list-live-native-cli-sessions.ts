import type { ListNativeCliRuntimesQuery, ListNativeCliRuntimesResponse, NativeCliSessionView } from '@monad/protocol';

import { nativeCliSessionViewSchema } from '@monad/protocol';

import { type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { nativeCliSessionAdapter } from './list-native-cli-sessions.ts';

type ListLiveNativeCliSessionsResult = NormalizedCursorPaginateResponse<
  NativeCliSessionView,
  'sessions',
  ListNativeCliRuntimesResponse
>;

// Daemon-wide list of every LIVE (starting/running) native-CLI/agent-adapter runtime across all
// projects. `streamControl` invalidates this cache from native_cli.started/exited notifications, so
// callers do not need their own interval polling.
const listLiveNativeCliSessionsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listLiveNativeCliSessions: builder.query<ListLiveNativeCliSessionsResult, ListNativeCliRuntimesQuery | undefined>({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-runtimes'].get({ query: arg ?? {} }),
          (raw) => ({
            ...raw,
            sessions: nativeCliSessionAdapter.setAll(
              nativeCliSessionAdapter.getInitialState(),
              raw.sessions.map((session) => nativeCliSessionViewSchema.parse(session))
            )
          })
        ),
      providesTags: ['NativeCliSessions']
    })
  })
});

export const { useListLiveNativeCliSessionsQuery } = listLiveNativeCliSessionsApi;
