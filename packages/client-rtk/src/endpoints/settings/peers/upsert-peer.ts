import type { OkResponse, PeerView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listPeersApi, peerAdapter } from './list-peers.ts';

export const upsertPeerApi = listPeersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertPeer: builder.mutation<OkResponse, PeerView>({
      queryFn: (peer: PeerView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.peers.put({ peer })),
      async onQueryStarted(peer, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listPeersApi.util.updateQueryData('listPeers', undefined, (draft) => {
            peerAdapter.upsertOne(draft, peer);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_res, _err, peer) => ['Peers', { type: 'Peers', id: peer.id }]
    })
  })
});

export const { useUpsertPeerMutation } = upsertPeerApi;
