import type { ChannelId, OkResponse, SetChannelCredentialRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { channelStatusApi } from './channel-status.ts';
import { deleteChannelApi } from './delete-channel.ts';

export const setChannelCredentialApi = deleteChannelApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setChannelCredential: builder.mutation<OkResponse, { id: ChannelId } & SetChannelCredentialRequest>({
      queryFn: ({ id, ...request }: { id: ChannelId } & SetChannelCredentialRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.channels({ id }).credential.put(request)),
      async onQueryStarted({ id, action }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          channelStatusApi.util.updateQueryData('channelStatus', undefined, (draft) => {
            const entry = draft.find((s) => s.id === id);
            if (entry) entry.hasToken = action === 'replace';
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Channels']
    })
  })
});

export const { useSetChannelCredentialMutation } = setChannelCredentialApi;
