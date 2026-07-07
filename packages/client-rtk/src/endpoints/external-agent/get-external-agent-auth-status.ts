import type { ExternalAgentAuthStatusResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getExternalAgentAuthStatusApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentAuthStatus: builder.query<ExternalAgentAuthStatusResponse, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['external-agents']({ name }).auth.status.get())
    })
  })
});

export const { useLazyGetExternalAgentAuthStatusQuery } = getExternalAgentAuthStatusApi;
