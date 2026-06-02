import type { DeleteCredentialRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { addCredentialApi } from './add-credential.ts';
import { credentialAdapter, listCredentialsApi } from './list-credentials.ts';

export const deleteCredentialApi = addCredentialApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteCredential: builder.mutation<OkResponse, DeleteCredentialRequest>({
      queryFn: ({ providerId, credentialId }: DeleteCredentialRequest, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1.settings.model.providers({ id: providerId })
            .credentials({ credId: credentialId })
            .delete()
        ),
      async onQueryStarted({ providerId, credentialId }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listCredentialsApi.util.updateQueryData('listCredentials', providerId, (draft) => {
            credentialAdapter.removeOne(draft, credentialId);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_r: unknown, _e: unknown, { providerId }: DeleteCredentialRequest) => [
        { type: 'Credentials', id: providerId }
      ]
    })
  })
});

export const { useDeleteCredentialMutation } = deleteCredentialApi;
