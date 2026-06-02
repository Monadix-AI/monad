import type { TestCredentialRequest, TestCredentialResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { deleteCredentialApi } from './delete-credential.ts';

export const testCredentialApi = deleteCredentialApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    testCredential: builder.mutation<TestCredentialResponse, TestCredentialRequest>({
      queryFn: ({ providerId, credentialId, modelId }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1.settings.model.providers({ id: providerId })
            .credentials({ credId: credentialId })
            .test.post({ modelId })
        ),
      invalidatesTags: (_r: unknown, _e: unknown, { providerId }) => [{ type: 'Credentials', id: providerId }]
    })
  })
});

export const { useTestCredentialMutation } = testCredentialApi;
