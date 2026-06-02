import type {
  AddSessionPlanTodoRequest,
  CreateOperationSourceHint,
  SessionId,
  SessionPlanTodoResponse
} from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

type AddSessionPlanTodoArgs = { sessionId: SessionId; origin?: CreateOperationSourceHint } & Omit<
  AddSessionPlanTodoRequest,
  'sessionId'
>;

export const addSessionPlanTodoApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    addSessionPlanTodo: builder.mutation<SessionPlanTodoResponse, AddSessionPlanTodoArgs>({
      queryFn: ({ sessionId, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id: sessionId }).plan.todos.post(body)),
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionPlan', id: sessionId }]
    })
  })
});

export const { useAddSessionPlanTodoMutation } = addSessionPlanTodoApi;
