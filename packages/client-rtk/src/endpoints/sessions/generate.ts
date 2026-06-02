import type { ChatMessage, SendMessageRequest, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { createSessionApi } from './create-session.ts';

export const generateApi = createSessionApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    generate: builder.mutation<ChatMessage, { id: SessionId } & SendMessageRequest>({
      queryFn: ({ id, text, ambientContext }: { id: SessionId } & SendMessageRequest, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id }).messages.block.post({ text, ambientContext }),
          (raw) => raw.message
        )
    })
  })
});

export const { useGenerateMutation } = generateApi;
