import type { MeshSessionView, SessionId, StartMeshAgentRequest } from '@monad/protocol';

import { meshSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listMeshSessionsApi, meshSessionAdapter } from './list-mesh-sessions.ts';

interface StartMeshAgentArgs extends Omit<StartMeshAgentRequest, 'transcriptTargetId'> {
  sessionId: SessionId;
}

const startMeshAgentApi = listMeshSessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startMeshAgent: builder.mutation<MeshSessionView, StartMeshAgentArgs>({
      queryFn: ({ sessionId, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.sessions.post({ ...body, transcriptTargetId: sessionId }),
          (raw) => meshSessionViewSchema.parse(raw.session)
        ),
      async onQueryStarted({ sessionId }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(
            listMeshSessionsApi.util.updateQueryData('listMeshSessions', sessionId, (draft) => {
              meshSessionAdapter.upsertOne(draft, data);
            })
          );
        } catch {}
      },
      invalidatesTags: (_result, _error, { sessionId }) => [
        'Sessions',
        'MeshSessions',
        { type: 'MeshSessions', id: sessionId }
      ]
    })
  })
});

export const { useStartMeshAgentMutation } = startMeshAgentApi;
