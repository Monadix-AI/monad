import type { ChatMessage, ListMessagesResponse, MessageId, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const PAGE_SIZE = 50;

export interface MessagesPage {
  messages: ChatMessage[];
  nextCursor?: string;
}

export const getMessagesApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMessages: builder.infiniteQuery<MessagesPage, SessionId, string | undefined>({
      infiniteQueryOptions: {
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => lastPage.nextCursor
      },
      queryFn: ({ queryArg: sessionId, pageParam }, api: { extra: unknown }) =>
        runTreaty(
          () =>
            clientOf(api)
              .treaty.v1.sessions({ id: sessionId })
              .messages.get({
                query: {
                  limit: PAGE_SIZE,
                  before: pageParam as MessageId | undefined,
                  includeInactive: false,
                  includeAncestors: false
                }
              }) as Promise<{ data: ListMessagesResponse | null | undefined; error: unknown }>,
          (raw) => ({ messages: raw.messages.filter((m) => m.active), nextCursor: raw.nextCursor })
        ),
      providesTags: (_result, _error, sessionId) => [{ type: 'Messages', id: sessionId }]
    })
  })
});

export const { useGetMessagesInfiniteQuery } = getMessagesApi;
