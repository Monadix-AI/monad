import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { setRolesApi } from '../roles/set-roles.ts';

// Clear all stored embeddings and let the daemon rebuild them with the current embedding model —
// used when the user switches the embedding model and chooses to re-index from scratch.
const reindexEmbeddingsApi = setRolesApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    reindexEmbeddings: builder.mutation<OkResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.embeddings.reindex.post())
    })
  })
});

export const { useReindexEmbeddingsMutation } = reindexEmbeddingsApi;
