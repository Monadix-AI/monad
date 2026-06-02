import type { GetProvenanceResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// A session's lineage: its ancestors (parents it was branched from) and descendants (branches off it).
export const provenanceApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    provenance: builder.query<GetProvenanceResponse, SessionId>({
      queryFn: (id: SessionId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).provenance.get()),
      providesTags: ['Sessions']
    })
  })
});

export const { useProvenanceQuery } = provenanceApi;
