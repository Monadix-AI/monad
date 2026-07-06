import type { ChatMessage, GenerateMessageResponse, SendMessageRequest, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { createSessionApi } from './create-session.ts';

export const generateApi = createSessionApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    generate: builder.mutation<ChatMessage, { id: SessionId } & SendMessageRequest>({
      queryFn: (
        { id, text, attachments, ambientContext }: { id: SessionId } & SendMessageRequest,
        api: { extra: unknown }
      ) =>
        runTreaty(
          () =>
            clientOf(api)
              .treaty.v1.sessions({ id })
              .messages.block.post({ text, attachments, ambientContext } as SendMessageRequest) as Promise<{
              data: GenerateMessageResponse | null | undefined;
              error: unknown;
            }>,
          (raw) => raw.message
        )
    })
  })
});

export const { useGenerateMutation } = generateApi;
