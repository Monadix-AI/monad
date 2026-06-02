import type { TestConnectionRequest, TestConnectionResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { testCredentialApi } from './credentials/test-credential.ts';

export const testConnectionApi = testCredentialApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    testConnection: builder.mutation<TestConnectionResponse, TestConnectionRequest>({
      queryFn: (req: TestConnectionRequest, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.settings.model['test-connection'].post({
            provider: req.provider,
            accessToken: req.accessToken
          })
        )
    })
  })
});

export const { useTestConnectionMutation } = testConnectionApi;
