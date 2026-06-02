import type { ChannelInstanceView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const channelAdapter = createEntityAdapter<ChannelInstanceView, string>({ selectId: (c) => c.id });
export const channelSelectors = channelAdapter.getSelectors();

export const listChannelsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listChannels: builder.query<EntityState<ChannelInstanceView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.channels.get(),
          (raw) => channelAdapter.setAll(channelAdapter.getInitialState(), raw.channels)
        ),
      providesTags: ['Channels']
    })
  })
});

export const { useListChannelsQuery } = listChannelsApi;
