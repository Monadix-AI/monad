import type { ChannelId, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { setChannelCredentialApi } from './set-channel-credential.ts';

export const pairChannelApi = setChannelCredentialApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    pairChannel: builder.mutation<OkResponse, ChannelId>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.channels({ id }).login.post()),
      invalidatesTags: ['Channels']
    })
  })
});

export const { usePairChannelMutation } = pairChannelApi;
