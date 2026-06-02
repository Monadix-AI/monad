import type {
  CreateOperationSourceHint,
  DeleteSessionPlanTodoRequest,
  DeleteSessionPlanTodoResponse,
  SessionId,
  SessionPlanTodoId
} from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

type DeleteSessionPlanTodoArgs = {
  sessionId: SessionId;
  todoId: SessionPlanTodoId;
  origin?: CreateOperationSourceHint;
} & Omit<DeleteSessionPlanTodoRequest, 'sessionId' | 'todoId'>;

export const deleteSessionPlanTodoApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteSessionPlanTodo: builder.mutation<DeleteSessionPlanTodoResponse, DeleteSessionPlanTodoArgs>({
      queryFn: ({ sessionId, todoId, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id: sessionId }).plan.todos({ todoId }).delete(body)),
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionPlan', id: sessionId }]
    })
  })
});

export const { useDeleteSessionPlanTodoMutation } = deleteSessionPlanTodoApi;
