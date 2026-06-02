import type { RestoreSessionRequest, RestoreSessionResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getMessagesApi } from './get-messages.ts';

// Rewind a session to a message checkpoint, deleting later messages. Refetch the (now shorter)
// history for this session.
export const restoreSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    restoreSession: builder.mutation<RestoreSessionResponse, { id: SessionId } & RestoreSessionRequest>({
      queryFn: ({ id, toMessageId }: { id: SessionId } & RestoreSessionRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).restore.post({ toMessageId })),
      async onQueryStarted({ id, toMessageId }, { dispatch, queryFulfilled }) {
        // pages[0] = newest messages (initialPageParam), pages[n] = oldest.
        // Within each page messages are ascending (oldest first in page).
        // Scan from the oldest page upward to find the checkpoint, then drop all newer pages.
        const patch = dispatch(
          getMessagesApi.util.updateQueryData('getMessages', id, (draft) => {
            let found = false;
            for (let i = draft.pages.length - 1; i >= 0; i--) {
              const page = draft.pages[i];
              if (!page) continue;
              const idx = page.messages.findIndex((m) => m.id === toMessageId);
              if (idx !== -1) {
                page.messages.splice(idx + 1);
                if (i > 0) {
                  draft.pages.splice(0, i);
                  draft.pageParams.splice(0, i);
                }
                found = true;
                break;
              }
            }
            if (!found) {
              draft.pages = [];
              draft.pageParams = [];
            }
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_result, _error, { id }: { id: SessionId } & RestoreSessionRequest) => [
        { type: 'Messages', id }
      ]
    })
  })
});

export const { useRestoreSessionMutation } = restoreSessionApi;
