import type { SendMessageRequest, SendMessageResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { createSessionApi } from '../sessions/create-session.ts';

const sendProjectMessageApi = createSessionApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    sendProjectMessage: builder.mutation<
      SendMessageResponse,
      { projectId: SessionId } & Pick<SendMessageRequest, 'text'>
    >({
      queryFn: (
        { projectId, text }: { projectId: SessionId } & Pick<SendMessageRequest, 'text'>,
        api: { extra: unknown }
      ) =>
        runTreaty(
          () => clientOf(api).treaty.v1.projects({ id: projectId }).messages.post({ text }),
          (raw) => raw as SendMessageResponse
        )
    })
  })
});

export const { useSendProjectMessageMutation } = sendProjectMessageApi;
