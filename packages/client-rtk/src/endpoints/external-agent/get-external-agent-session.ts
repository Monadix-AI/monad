import type { ExternalAgentSessionView, TranscriptTargetId } from '@monad/protocol';

import { externalAgentSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getExternalAgentSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentSession: builder.query<
      ExternalAgentSessionView,
      { id: string; transcriptTargetId: TranscriptTargetId }
    >({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['external-agent-sessions']({ id }).get({ query: { transcriptTargetId } }),
          (raw) => externalAgentSessionViewSchema.parse(raw.session)
        )
    })
  })
});

export const { useGetExternalAgentSessionQuery } = getExternalAgentSessionApi;
