import type { ExternalAgentAuthSessionView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const startExternalAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startExternalAgentAuth: builder.mutation<ExternalAgentAuthSessionView, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['external-agents']({ name }).auth.start.post(),
          (raw) => raw.session
        )
    })
  })
});

export const { useStartExternalAgentAuthMutation } = startExternalAgentAuthApi;
