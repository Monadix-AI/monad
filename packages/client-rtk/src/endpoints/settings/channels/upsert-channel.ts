import type { ChannelInstanceView, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { channelStatusApi } from './channel-status.ts';
import { channelAdapter, listChannelsApi } from './list-channels.ts';

export const upsertChannelApi = channelStatusApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertChannel: builder.mutation<OkResponse, ChannelInstanceView>({
      queryFn: (channel: ChannelInstanceView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.channels({ id: channel.id }).put({ channel })),
      async onQueryStarted(channel, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listChannelsApi.util.updateQueryData('listChannels', undefined, (draft) => {
            channelAdapter.upsertOne(draft, channel);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Channels']
    })
  })
});

export const { useUpsertChannelMutation } = upsertChannelApi;
