import type {
  InboxSummary,
  ListInboxQuery,
  ListInboxResponse,
  ListMentionInboxQuery,
  ListMentionInboxResponse,
  MarkInboxReadRequest,
  MarkInboxReadResponse
} from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const inboxApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listInbox: builder.query<ListInboxResponse, ListInboxQuery | undefined>({
      queryFn: (args, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.inbox.items.get({
            query: { filter: args?.filter, limit: args?.limit, cursor: args?.cursor }
          })
        ),
      providesTags: ['Inbox']
    }),
    getInboxSummary: builder.query<InboxSummary, void>({
      queryFn: (_args, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.inbox.summary.get()),
      providesTags: ['Inbox']
    }),
    markInboxRead: builder.mutation<MarkInboxReadResponse, MarkInboxReadRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.inbox.read.post(body)),
      invalidatesTags: ['Inbox']
    }),
    listMentionInbox: builder.query<ListMentionInboxResponse, ListMentionInboxQuery | undefined>({
      queryFn: (args, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.inbox.mentions.get({ query: { limit: args?.limit } })),
      providesTags: ['Inbox']
    })
  })
});

export const { useGetInboxSummaryQuery, useListInboxQuery, useListMentionInboxQuery, useMarkInboxReadMutation } =
  inboxApi;
