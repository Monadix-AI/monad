import type { CreateSessionRequest, SessionId } from '@monad/protocol';

import {
  clientOf,
  type IdempotentMutationArgs,
  idempotencyOptions,
  runTreaty,
  treatyJson
} from '../../endpoint-helpers.ts';
import { listSessionsApi } from './list-sessions.ts';

export const createSessionApi = listSessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createSession: builder.mutation<SessionId, CreateSessionRequest & IdempotentMutationArgs>({
      queryFn: ({ idempotencyKey, ...body }: CreateSessionRequest & IdempotentMutationArgs, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions.post(body, idempotencyOptions({ idempotencyKey })),
          (raw) => treatyJson(raw).sessionId
        ),
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useCreateSessionMutation } = createSessionApi;
