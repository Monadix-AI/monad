import type { NativeCliSessionView, TranscriptTargetId } from '@monad/protocol';

import { nativeCliSessionViewSchema } from '@monad/protocol';
import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const nativeCliSessionAdapter = createEntityAdapter<NativeCliSessionView>();
export const nativeCliSessionSelectors = nativeCliSessionAdapter.getSelectors();

export const listNativeCliSessionsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listNativeCliSessions: builder.query<EntityState<NativeCliSessionView, string>, TranscriptTargetId>({
      queryFn: (sessionId, api: { extra: unknown }) =>
        runTreaty(
          () =>
            sessionId.startsWith('prj_')
              ? clientOf(api).treaty.v1.projects({ id: sessionId })['native-cli-sessions'].get()
              : clientOf(api).treaty.v1.sessions({ id: sessionId })['native-cli-sessions'].get(),
          (raw) =>
            nativeCliSessionAdapter.setAll(
              nativeCliSessionAdapter.getInitialState(),
              raw.sessions.map((session) => nativeCliSessionViewSchema.parse(session))
            )
        ),
      providesTags: (_result, _error, sessionId) => ['NativeCliSessions', { type: 'NativeCliSessions', id: sessionId }]
    })
  })
});

export const { useListNativeCliSessionsQuery } = listNativeCliSessionsApi;
