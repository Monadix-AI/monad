import type { NativeCliSessionView } from '@monad/protocol';
import type { EntityState } from '@reduxjs/toolkit';

import { nativeCliSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { nativeCliSessionAdapter } from './list-native-cli-sessions.ts';

// Daemon-wide list of every LIVE (starting/running) native-CLI/agent-adapter runtime across all
// projects — one query the Studio Swarm overview polls once, instead of a per-project subscription
// each. Reuses nativeCliSessionAdapter so both list endpoints normalize into the same shape.
const listLiveNativeCliSessionsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listLiveNativeCliSessions: builder.query<EntityState<NativeCliSessionView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-runtimes'].get(),
          (raw) =>
            nativeCliSessionAdapter.setAll(
              nativeCliSessionAdapter.getInitialState(),
              raw.sessions.map((session) => nativeCliSessionViewSchema.parse(session))
            )
        ),
      providesTags: ['NativeCliSessions']
    })
  })
});

export const { useListLiveNativeCliSessionsQuery } = listLiveNativeCliSessionsApi;
