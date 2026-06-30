import type { ListWorkspaceExperiencesResponse } from '@monad/protocol';
import type { QueryReturnValue } from '@reduxjs/toolkit/query';

import { clientOf, type MonadApiError, runTreaty } from '../../endpoint-helpers.ts';
import { removeAtomPackApi } from './remove-atom-pack.ts';

type WorkspaceExperiencesTreaty = {
  'workspace-experiences': {
    get(): Promise<{ data: ListWorkspaceExperiencesResponse | null | undefined; error: unknown }>;
  };
};

export const listWorkspaceExperiencesApi = removeAtomPackApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listWorkspaceExperiences: builder.query<ListWorkspaceExperiencesResponse, void>({
      queryFn: (
        _arg,
        api: { extra: unknown }
      ): Promise<QueryReturnValue<ListWorkspaceExperiencesResponse, MonadApiError, undefined>> => {
        const atoms = clientOf(api).treaty.v1.atoms as WorkspaceExperiencesTreaty;
        return runTreaty(() => atoms['workspace-experiences'].get());
      },
      providesTags: ['Atoms']
    })
  })
});

export const { useListWorkspaceExperiencesQuery } = listWorkspaceExperiencesApi;
