import type { ListUiItemsResponse, MessageId, TranscriptTargetId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const PAGE_SIZE = 50;

interface UiItemsWindowArg {
  sessionId: TranscriptTargetId;
  /** Page toward older messages (returns the newest page strictly older than this id). */
  before?: MessageId;
  /** Page toward newer messages (returns the oldest page strictly newer than this id). */
  after?: MessageId;
  /** Open an inclusive window centred on this message id (deep-link / search-to-message). */
  around?: MessageId;
}

// A single windowed page of the transcript, fetched lazily for history pagination. The live
// transcript arrives over the bounded stream (streamUiItems); this fills in older/newer pages
// on demand. `olderCursor`/`newerCursor` are RAW message ids (the `before`/`after` for the
// next page) — never derived from projected UI items, whose ids are not message ids.
const getUiItemsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getUiItemsWindow: builder.query<ListUiItemsResponse, UiItemsWindowArg>({
      queryFn: ({ sessionId, before, after, around }, api: { extra: unknown }) =>
        runTreaty(
          () =>
            sessionId.startsWith('prj_')
              ? clientOf(api)
                  .treaty.v1.projects({ id: sessionId })
                  ['ui-items'].get({
                    query: { limit: PAGE_SIZE, before, after, around, includeInactive: false, includeAncestors: false }
                  })
              : clientOf(api)
                  .treaty.v1.sessions({ id: sessionId })
                  ['ui-items'].get({
                    query: { limit: PAGE_SIZE, before, after, around, includeInactive: false, includeAncestors: false }
                  }),
          (raw) => raw as ListUiItemsResponse
        ),
      providesTags: (_result, _error, { sessionId }) => [{ type: 'Messages', id: sessionId }]
    })
  })
});

export const { useLazyGetUiItemsWindowQuery } = getUiItemsApi;
