import type { ChannelId, ChannelPairingRequest } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { setChannelCredentialApi } from './set-channel-credential.ts';

export const channelPairingAdapter = createEntityAdapter<ChannelPairingRequest, string>({
  selectId: (p) => p.code
});
export const channelPairingSelectors = channelPairingAdapter.getSelectors();

export const listChannelPairingsApi = setChannelCredentialApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listChannelPairings: builder.query<EntityState<ChannelPairingRequest, string>, ChannelId>({
      queryFn: (id: ChannelId, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.channels({ id }).pairings.get(),
          (raw) => channelPairingAdapter.setAll(channelPairingAdapter.getInitialState(), raw.pairings)
        ),
      providesTags: ['Channels']
    })
  })
});

export const { useListChannelPairingsQuery } = listChannelPairingsApi;
