import type { ResetSessionResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getMessagesApi } from './get-messages.ts';
import { streamUiItemsApi } from './stream-ui-items.ts';

export const resetSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resetSession: builder.mutation<ResetSessionResponse, SessionId>({
      queryFn: (id: SessionId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).reset.post()),
      async onQueryStarted(id, { dispatch, queryFulfilled }) {
        const messagePatch = dispatch(
          getMessagesApi.util.updateQueryData('getMessages', id, (draft) => {
            draft.pages = [{ messages: [], nextCursor: undefined }];
            draft.pageParams = [undefined];
          })
        );
        // History pages live in component state (the Chat accumulator) and reset on session
        // change / branch / restore; invalidatesTags('Messages') drops any cached window pages.
        const uiStreamPatch = dispatch(
          streamUiItemsApi.util.updateQueryData('streamUiItems', id, (draft) => {
            draft.items = [];
            draft.streamError = undefined;
          })
        );
        try {
          await queryFulfilled;
        } catch {
          messagePatch.undo();
          uiStreamPatch.undo();
        }
      },
      invalidatesTags: ['Messages', 'Sessions']
    })
  })
});

export const { useResetSessionMutation } = resetSessionApi;
