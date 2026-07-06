import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { upsertPeerApi } from './upsert-peer.ts';

type SetPeerCredentialArg = { id: string; token: string };

const setPeerCredentialApi = upsertPeerApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setPeerCredential: builder.mutation<OkResponse, SetPeerCredentialArg>({
      queryFn: ({ id, token }: SetPeerCredentialArg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.peers({ id }).credential.put({ token })),
      invalidatesTags: (_res, _err, { id }) => [{ type: 'Peers', id }]
    })
  })
});

export const { useSetPeerCredentialMutation } = setPeerCredentialApi;
