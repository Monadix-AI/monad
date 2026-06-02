import type { ForwardToAcpRequest, ForwardToAcpResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { generateApi } from './generate.ts';

const forwardToAcpApi = generateApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    forwardToAcp: builder.mutation<
      ForwardToAcpResponse,
      { sessionId: SessionId; agentName: string } & ForwardToAcpRequest
    >({
      queryFn: (
        {
          sessionId,
          agentName,
          text,
          ambientContext
        }: { sessionId: SessionId; agentName: string } & ForwardToAcpRequest,
        api: { extra: unknown }
      ) =>
        runTreaty(
          () =>
            clientOf(api).treaty.v1.sessions({ id: sessionId }).acp({ agent: agentName }).post({
              text,
              ambientContext
            }),
          (raw) => raw as ForwardToAcpResponse
        )
    })
  })
});

export const { useForwardToAcpMutation } = forwardToAcpApi;
