import type { PeerView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const peerAdapter = createEntityAdapter<PeerView, string>({ selectId: (p) => p.id });
export const peerSelectors = peerAdapter.getSelectors();

export const listPeersApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listPeers: builder.query<EntityState<PeerView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.peers.get(),
          (raw) => peerAdapter.setAll(peerAdapter.getInitialState(), raw.peers)
        ),
      providesTags: ['Peers']
    })
  })
});

export const { useListPeersQuery } = listPeersApi;
