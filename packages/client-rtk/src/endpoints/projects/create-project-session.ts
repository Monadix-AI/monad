import type { CreateProjectSessionRequest, ProjectId, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import {
  clientOf,
  type IdempotentMutationArgs,
  idempotencyOptions,
  runTreaty,
  treatyJson
} from '../../endpoint-helpers.ts';

// The explicit "create a session under this project" entry point (Track B P6b, resolved decision
// 3): no default session is auto-created when a project is made, so the project shell needs this
// as its minimal owed UI once a project has zero sessions.
const createProjectSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createProjectSession: builder.mutation<
      SessionId,
      { projectId: ProjectId } & CreateProjectSessionRequest & IdempotentMutationArgs
    >({
      queryFn: ({ projectId, idempotencyKey, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () =>
            clientOf(api)
              .treaty.v1.projects({ id: projectId })
              .sessions.post(body, idempotencyOptions({ idempotencyKey })),
          (raw) => treatyJson(raw).sessionId
        ),
      invalidatesTags: (_result, _error, { projectId }) => [{ type: 'Sessions', id: projectId }, 'Sessions']
    })
  })
});

export const { useCreateProjectSessionMutation } = createProjectSessionApi;
