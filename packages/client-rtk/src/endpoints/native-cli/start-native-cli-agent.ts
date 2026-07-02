import type { NativeCliSessionView, SessionId, StartNativeCliAgentRequest } from '@monad/protocol';

import { nativeCliSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listNativeCliSessionsApi, nativeCliSessionAdapter } from './list-native-cli-sessions.ts';

interface StartNativeCliAgentArgs extends StartNativeCliAgentRequest {
  sessionId: SessionId;
}

export const startNativeCliAgentApi = listNativeCliSessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startNativeCliAgent: builder.mutation<NativeCliSessionView, StartNativeCliAgentArgs>({
      queryFn: ({ sessionId, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId })['native-cli-agents'].start.post(body),
          (raw) => nativeCliSessionViewSchema.parse(raw.session)
        ),
      async onQueryStarted({ sessionId }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(
            listNativeCliSessionsApi.util.updateQueryData('listNativeCliSessions', sessionId, (draft) => {
              nativeCliSessionAdapter.upsertOne(draft, data);
            })
          );
        } catch {}
      },
      invalidatesTags: (_result, _error, { sessionId }) => [
        'Sessions',
        'NativeCliSessions',
        { type: 'NativeCliSessions', id: sessionId }
      ]
    })
  })
});

export const { useStartNativeCliAgentMutation } = startNativeCliAgentApi;
