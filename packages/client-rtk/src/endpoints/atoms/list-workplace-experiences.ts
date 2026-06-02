import type { ListWorkplaceExperiencesResponse } from '@monad/protocol';
import type { QueryReturnValue } from '@reduxjs/toolkit/query';

import { clientOf, type MonadApiError, runTreaty } from '../../endpoint-helpers.ts';
import { updateAtomPackApi } from './update-atom-pack.ts';

type WorkplaceExperiencesTreaty = {
  'workplace-experiences': {
    get(): Promise<{ data: ListWorkplaceExperiencesResponse | null | undefined; error: unknown }>;
  };
};

export const listWorkplaceExperiencesApi = updateAtomPackApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listWorkplaceExperiences: builder.query<ListWorkplaceExperiencesResponse, void>({
      queryFn: (
        _arg,
        api: { extra: unknown }
      ): Promise<QueryReturnValue<ListWorkplaceExperiencesResponse, MonadApiError, undefined>> => {
        const atoms = clientOf(api).treaty.v1.atoms as WorkplaceExperiencesTreaty;
        return runTreaty(() => atoms['workplace-experiences'].get());
      },
      providesTags: ['Atoms']
    })
  })
});

export const { useListWorkplaceExperiencesQuery } = listWorkplaceExperiencesApi;
