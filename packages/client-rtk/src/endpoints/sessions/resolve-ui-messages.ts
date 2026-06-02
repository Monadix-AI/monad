import type { ResolveUiMessagesRequest, ResolveUiMessagesResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export interface ResolveUiMessagesArg extends ResolveUiMessagesRequest {
  sessionId: SessionId;
}

export const resolveUiMessagesApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resolveUiMessages: builder.query<ResolveUiMessagesResponse, ResolveUiMessagesArg>({
      queryFn: ({ sessionId, messageIds }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.sessions({ id: sessionId })['ui-messages'].resolve.post({ messageIds })
        ),
      providesTags: (_result, _error, { sessionId }) => [{ type: 'Messages', id: sessionId }]
    })
  })
});

export const { useLazyResolveUiMessagesQuery } = resolveUiMessagesApi;
