import type { SendMessageRequest, SendMessageResponse, SessionId } from '@monad/protocol';

import { clientOf, type IdempotentMutationArgs, idempotencyOptions, runTreaty } from '../../endpoint-helpers.ts';
import { generateApi } from './generate.ts';

export const sendMessageApi = generateApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    sendMessage: builder.mutation<
      SendMessageResponse,
      { sessionId: SessionId } & SendMessageRequest & IdempotentMutationArgs
    >({
      queryFn: (
        {
          sessionId,
          text,
          attachments,
          generate,
          continueFromHistory,
          ambientContext,
          idempotencyKey
        }: { sessionId: SessionId } & SendMessageRequest & IdempotentMutationArgs,
        api: { extra: unknown }
      ) =>
        runTreaty(
          () =>
            clientOf(api)
              .treaty.v1.sessions({ id: sessionId })
              .messages.post(
                {
                  text,
                  attachments,
                  generate,
                  continueFromHistory,
                  ambientContext
                } as SendMessageRequest,
                idempotencyOptions({ idempotencyKey })
              ),
          (raw) => raw as SendMessageResponse
        )
    })
  })
});

export const { useSendMessageMutation } = sendMessageApi;
