import type { SendMessageRequest, SendMessageResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { generateApi } from './generate.ts';

export const sendMessageApi = generateApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    sendMessage: builder.mutation<SendMessageResponse, { sessionId: SessionId } & SendMessageRequest>({
      queryFn: (
        { sessionId, text, generate, ambientContext }: { sessionId: SessionId } & SendMessageRequest,
        api: { extra: unknown }
      ) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId }).messages.post({ text, generate, ambientContext }),
          (raw) => raw as SendMessageResponse
        )
    })
  })
});

export const { useSendMessageMutation } = sendMessageApi;
