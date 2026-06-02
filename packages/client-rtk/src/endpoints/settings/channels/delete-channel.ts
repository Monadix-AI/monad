import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { channelAdapter, listChannelsApi } from './list-channels.ts';
import { upsertChannelApi } from './upsert-channel.ts';

export const deleteChannelApi = upsertChannelApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteChannel: builder.mutation<OkResponse, string>({
      queryFn: (id: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.channels({ id }).delete()),
      async onQueryStarted(id, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listChannelsApi.util.updateQueryData('listChannels', undefined, (draft) => {
            channelAdapter.removeOne(draft, id);
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

export const { useDeleteChannelMutation } = deleteChannelApi;
