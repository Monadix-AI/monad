import type { NativeCliSessionView } from '@monad/protocol';
import type { EntityState } from '@reduxjs/toolkit';

import { listNativeCliSessionsResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { nativeCliSessionAdapter } from './list-native-cli-sessions.ts';

const listNativeCliSessionSummariesApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listNativeCliSessionSummaries: builder.query<EntityState<NativeCliSessionView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-session-summaries'].get(),
          (raw) =>
            nativeCliSessionAdapter.setAll(
              nativeCliSessionAdapter.getInitialState(),
              listNativeCliSessionsResponseSchema.parse(raw).sessions
            )
        ),
      providesTags: ['NativeCliSessions']
    })
  })
});

export const { useListNativeCliSessionSummariesQuery } = listNativeCliSessionSummariesApi;
