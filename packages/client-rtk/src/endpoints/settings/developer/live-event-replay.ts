import type {
  GetLiveEventReplayFramesQuery,
  ListLiveEventReplayCapturesResponse,
  LiveEventReplayFramePage,
  MeshSessionId
} from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

interface GetLiveEventReplayFramesArg {
  meshSessionId: MeshSessionId;
  observationEpoch: string;
  query?: Partial<GetLiveEventReplayFramesQuery>;
}

const liveEventReplayApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listLiveEventReplayCaptures: builder.query<ListLiveEventReplayCapturesResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.developer['live-events'].get())
    }),
    getLiveEventReplayFrames: builder.query<LiveEventReplayFramePage, GetLiveEventReplayFramesArg>({
      queryFn: ({ meshSessionId, observationEpoch, query }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1.settings.developer['live-events']({ meshSessionId })({ observationEpoch })
            .get({
              query: { offset: 0, limit: 1_000, ...query }
            })
        )
    })
  })
});

export const {
  useGetLiveEventReplayFramesQuery,
  useLazyGetLiveEventReplayFramesQuery,
  useListLiveEventReplayCapturesQuery
} = liveEventReplayApi;
