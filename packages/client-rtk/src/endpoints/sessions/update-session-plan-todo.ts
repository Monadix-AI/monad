import type {
  CreateOperationSourceHint,
  SessionId,
  SessionPlanTodoId,
  SessionPlanTodoResponse,
  UpdateSessionPlanTodoRequest
} from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

type UpdateSessionPlanTodoArgs = {
  sessionId: SessionId;
  todoId: SessionPlanTodoId;
  origin?: CreateOperationSourceHint;
} & Omit<UpdateSessionPlanTodoRequest, 'sessionId' | 'todoId'>;

export const updateSessionPlanTodoApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateSessionPlanTodo: builder.mutation<SessionPlanTodoResponse, UpdateSessionPlanTodoArgs>({
      queryFn: ({ sessionId, todoId, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id: sessionId }).plan.todos({ todoId }).patch(body)),
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionPlan', id: sessionId }]
    })
  })
});

export const { useUpdateSessionPlanTodoMutation } = updateSessionPlanTodoApi;
