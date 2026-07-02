import type { ProjectId, SendMessageRequest, SendMessageResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { createSessionApi } from '../sessions/create-session.ts';

const sendProjectMessageApi = createSessionApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    sendProjectMessage: builder.mutation<
      SendMessageResponse,
      { projectId: ProjectId } & Pick<SendMessageRequest, 'text'>
    >({
      queryFn: (
        { projectId, text }: { projectId: ProjectId } & Pick<SendMessageRequest, 'text'>,
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
