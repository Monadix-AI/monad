import type { SendMessageRequest, SendMessageResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { createSessionApi } from '../sessions/create-session.ts';

const sendChannelMessageApi = createSessionApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    sendChannelMessage: builder.mutation<
      SendMessageResponse,
      { channelId: SessionId } & Pick<SendMessageRequest, 'text'>
    >({
      queryFn: (
        { channelId, text }: { channelId: SessionId } & Pick<SendMessageRequest, 'text'>,
        api: { extra: unknown }
      ) =>
        runTreaty(
          () => clientOf(api).treaty.v1.channels({ id: channelId }).messages.post({ text }),
          (raw) => raw as SendMessageResponse
        )
    })
  })
});

export const { useSendChannelMessageMutation } = sendChannelMessageApi;
