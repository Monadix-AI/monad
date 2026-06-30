import type {
  NativeCliApprovalResolutionRequest,
  NativeCliAuthSessionView,
  NativeCliAuthStatusResponse,
  NativeCliHistoryPageRequest,
  NativeCliHistoryPageResponse,
  NativeCliInputRequest,
  NativeCliResizeRequest,
  NativeCliSessionView,
  SessionId,
  StartNativeCliAgentRequest
} from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface StartNativeCliAgentArgs extends StartNativeCliAgentRequest {
  sessionId: SessionId;
}

interface NativeCliInputArgs extends NativeCliInputRequest {
  id: string;
}

interface NativeCliResizeArgs extends NativeCliResizeRequest {
  id: string;
}

interface NativeCliApprovalArgs extends NativeCliApprovalResolutionRequest {
  id: string;
}

interface NativeCliHistoryPageArgs extends NativeCliHistoryPageRequest {
  id: string;
}

const nativeCliApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startNativeCliAgent: builder.mutation<NativeCliSessionView, StartNativeCliAgentArgs>({
      queryFn: ({ sessionId, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId })['native-cli-agents'].start.post(body),
          (raw) => raw.session
        ),
      async onQueryStarted({ sessionId }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(
            nativeCliApi.util.updateQueryData('listNativeCliSessions', sessionId, (draft) => {
              const index = draft.findIndex((session) => session.id === data.id);
              if (index >= 0) draft[index] = data;
              else draft.push(data);
            })
          );
        } catch {}
      },
      invalidatesTags: (_result, _error, { sessionId }) => [
        'Sessions',
        'NativeCliSessions',
        { type: 'NativeCliSessions', id: sessionId }
      ]
    }),
    getNativeCliSession: builder.query<NativeCliSessionView, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-sessions']({ id }).get(),
          (raw) => raw.session
        )
    }),
    listNativeCliSessions: builder.query<NativeCliSessionView[], SessionId>({
      queryFn: (sessionId, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId })['native-cli-sessions'].get(),
          (raw) => raw.sessions
        ),
      providesTags: (_result, _error, sessionId) => ['NativeCliSessions', { type: 'NativeCliSessions', id: sessionId }]
    }),
    inputNativeCliSession: builder.mutation<{ ok: true }, NativeCliInputArgs>({
      queryFn: ({ id, input }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-sessions']({ id }).input.post({ input }))
    }),
    resizeNativeCliSession: builder.mutation<{ ok: true }, NativeCliResizeArgs>({
      queryFn: ({ id, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-sessions']({ id }).resize.post({ cols, rows }))
    }),
    approveNativeCliSession: builder.mutation<{ ok: true }, NativeCliApprovalArgs>({
      queryFn: ({ id, requestId, allow, reason }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1['native-cli-sessions']({ id }).approval.post({ requestId, allow, reason })
        )
    }),
    loadNativeCliHistoryPage: builder.mutation<NativeCliHistoryPageResponse['page'], NativeCliHistoryPageArgs>({
      queryFn: ({ id, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-sessions']({ id })['history-page'].post(body),
          (raw) => raw.page
        )
    }),
    stopNativeCliSession: builder.mutation<{ ok: true }, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-sessions']({ id }).stop.post()),
      invalidatesTags: ['NativeCliSessions']
    }),
    startNativeCliAuth: builder.mutation<NativeCliAuthSessionView, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-agents']({ name }).auth.start.post(),
          (raw) => raw.session
        )
    }),
    getNativeCliAuth: builder.query<NativeCliAuthSessionView, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).get(),
          (raw) => raw.session
        )
    }),
    inputNativeCliAuth: builder.mutation<{ ok: true }, NativeCliInputArgs>({
      queryFn: ({ id, input }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).input.post({ input }))
    }),
    resizeNativeCliAuth: builder.mutation<{ ok: true }, NativeCliResizeArgs>({
      queryFn: ({ id, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).resize.post({ cols, rows }))
    }),
    stopNativeCliAuth: builder.mutation<{ ok: true }, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).stop.post())
    }),
    getNativeCliAuthStatus: builder.query<NativeCliAuthStatusResponse, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-agents']({ name }).auth.status.get())
    })
  })
});

export const {
  useApproveNativeCliSessionMutation,

  useGetNativeCliAuthQuery,

  useGetNativeCliSessionQuery,

  useInputNativeCliSessionMutation,

  useInputNativeCliAuthMutation,

  useLazyGetNativeCliAuthStatusQuery,

  useListNativeCliSessionsQuery,

  useResizeNativeCliAuthMutation,

  useResizeNativeCliSessionMutation,

  useStartNativeCliAuthMutation,

  useStartNativeCliAgentMutation,

  useStopNativeCliAuthMutation,

  useStopNativeCliSessionMutation
} = nativeCliApi;
