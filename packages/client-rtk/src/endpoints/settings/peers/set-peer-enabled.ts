import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listPeersApi, peerAdapter } from './list-peers.ts';
import { upsertPeerApi } from './upsert-peer.ts';

type SetPeerEnabledArg = { id: string; enabled: boolean };

const setPeerEnabledApi = upsertPeerApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setPeerEnabled: builder.mutation<OkResponse, SetPeerEnabledArg>({
      queryFn: ({ id, enabled }: SetPeerEnabledArg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.peers({ id })[enabled ? 'enable' : 'disable'].post()),
      async onQueryStarted({ id, enabled }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listPeersApi.util.updateQueryData('listPeers', undefined, (draft) => {
            peerAdapter.updateOne(draft, { id, changes: { enabled } });
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_res, _err, { id }) => [{ type: 'Peers', id }]
    })
  })
});

export const { useSetPeerEnabledMutation } = setPeerEnabledApi;
