import type { CreateSessionRequest, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listSessionsApi } from './list-sessions.ts';

export const createSessionApi = listSessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createSession: builder.mutation<SessionId, CreateSessionRequest>({
      queryFn: (args: CreateSessionRequest, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions.post(args),
          (raw) => raw.sessionId
        ),
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useCreateSessionMutation } = createSessionApi;
