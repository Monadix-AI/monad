import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listPeersApi, peerAdapter } from './list-peers.ts';
import { upsertPeerApi } from './upsert-peer.ts';

const deletePeerApi = upsertPeerApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deletePeer: builder.mutation<OkResponse, string>({
      queryFn: (id: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.peers({ id }).delete()),
      async onQueryStarted(id, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listPeersApi.util.updateQueryData('listPeers', undefined, (draft) => {
            peerAdapter.removeOne(draft, id);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_res, _err, id) => ['Peers', { type: 'Peers', id }]
    })
  })
});

export const { useDeletePeerMutation } = deletePeerApi;
