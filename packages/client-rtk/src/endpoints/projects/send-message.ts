import type { SendMessageRequest, SendMessageResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { createSessionApi } from '../sessions/create-session.ts';

// Routes through the session-scoped channel-message-routing path (fan-out to project members,
// direct ACP/mesh-agent targets) — the only surviving HTTP entry point to sendProjectMessage
// after Track B P6b removed /projects/:id/messages (a project has no transcript of its own).
const sendProjectMessageApi = createSessionApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    sendProjectMessage: builder.mutation<
      SendMessageResponse,
      { sessionId: SessionId } & Pick<SendMessageRequest, 'attachments' | 'text'>
    >({
      queryFn: (
        { sessionId, text, attachments }: { sessionId: SessionId } & Pick<SendMessageRequest, 'attachments' | 'text'>,
        api: { extra: unknown }
      ) =>
        runTreaty(
          () =>
            clientOf(api)
              .treaty.v1.channels({ id: sessionId })
              .messages.post({ text, attachments } as Pick<SendMessageRequest, 'attachments' | 'text'>),
          (raw) => raw as SendMessageResponse
        )
    })
  })
});

export const { useSendProjectMessageMutation } = sendProjectMessageApi;
