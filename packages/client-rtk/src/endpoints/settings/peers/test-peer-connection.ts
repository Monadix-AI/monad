import type { TestPeerConnectionResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { upsertPeerApi } from './upsert-peer.ts';

const testPeerConnectionApi = upsertPeerApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    testPeerConnection: builder.mutation<TestPeerConnectionResponse, string>({
      queryFn: (id: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.peers({ id })['test-connection'].post())
    })
  })
});

export const { useTestPeerConnectionMutation } = testPeerConnectionApi;
