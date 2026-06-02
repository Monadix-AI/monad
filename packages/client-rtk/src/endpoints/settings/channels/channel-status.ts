import type { ChannelStatus } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listChannelsApi } from './list-channels.ts';

export const channelStatusApi = listChannelsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    channelStatus: builder.query<ChannelStatus[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.channels.status.get(),
          (raw) => raw.statuses
        ),
      providesTags: ['Channels']
    })
  })
});

export const { useChannelStatusQuery } = channelStatusApi;
