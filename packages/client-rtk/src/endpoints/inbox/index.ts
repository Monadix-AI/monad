import type { ListMentionInboxQuery, ListMentionInboxResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const inboxApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMentionInbox: builder.query<ListMentionInboxResponse, ListMentionInboxQuery | undefined>({
      queryFn: (args, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.inbox.mentions.get({ query: { limit: args?.limit } })),
      providesTags: ['Inbox']
    })
  })
});

export const { useListMentionInboxQuery } = inboxApi;
