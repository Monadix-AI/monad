import type { GetPeerResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listPeersApi } from './list-peers.ts';

const getPeerApi = listPeersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getPeer: builder.query<GetPeerResponse, string>({
      queryFn: (id: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.peers({ id }).get()),
      providesTags: (_res, _err, id) => [{ type: 'Peers', id }]
    })
  })
});

export const { useGetPeerQuery } = getPeerApi;
