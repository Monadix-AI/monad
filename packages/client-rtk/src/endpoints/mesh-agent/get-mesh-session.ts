import type { MeshSessionView, SessionId } from '@monad/protocol';

import { meshSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getMeshSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshSession: builder.query<MeshSessionView, { id: string; transcriptTargetId: SessionId }>({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.sessions({ id }).get({ query: { transcriptTargetId } }),
          (raw) => meshSessionViewSchema.parse(raw.session)
        )
    })
  })
});

export const { useGetMeshSessionQuery } = getMeshSessionApi;
