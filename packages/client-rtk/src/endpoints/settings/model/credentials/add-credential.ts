import type { AddCredentialRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listCredentialsApi } from './list-credentials.ts';

export const addCredentialApi = listCredentialsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    addCredential: builder.mutation<string, AddCredentialRequest>({
      queryFn: (req: AddCredentialRequest, api: { extra: unknown }) => {
        const { providerId, ...body } = req;
        return runTreaty(
          () => clientOf(api).treaty.v1.settings.model.providers({ id: providerId }).credentials.post(body),
          (raw) => raw.id
        );
      },
      invalidatesTags: (_r: unknown, _e: unknown, req: AddCredentialRequest) => [
        { type: 'Credentials', id: req.providerId },
        'InitStatus'
      ]
    })
  })
});

export const { useAddCredentialMutation } = addCredentialApi;
