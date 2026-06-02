import type { OkResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const stopMeshSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    stopMeshSession: builder.mutation<OkResponse, { id: string; transcriptTargetId: SessionId }>({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.mesh.sessions({ id }).stop.post(undefined, { query: { transcriptTargetId } })
        ),
      invalidatesTags: ['MeshSessions']
    })
  })
});

export const { useStopMeshSessionMutation } = stopMeshSessionApi;
