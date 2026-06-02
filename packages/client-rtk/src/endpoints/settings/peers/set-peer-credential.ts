import type { OkResponse, SetPeerCredentialRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { upsertPeerApi } from './upsert-peer.ts';

const setPeerCredentialApi = upsertPeerApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setPeerCredential: builder.mutation<OkResponse, { id: string } & SetPeerCredentialRequest>({
      queryFn: ({ id, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.peers({ id }).credential.put(body)),
      invalidatesTags: (_res, _err, { id }) => [{ type: 'Peers', id }]
    })
  })
});

export const { useSetPeerCredentialMutation } = setPeerCredentialApi;
