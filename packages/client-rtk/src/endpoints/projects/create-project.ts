import type { CreateWorkplaceProjectRequest, CreateWorkplaceProjectResponse, ProjectId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import {
  clientOf,
  type IdempotentMutationArgs,
  idempotencyOptions,
  runTreaty,
  treatyJson
} from '../../endpoint-helpers.ts';

const createWorkplaceProjectApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createWorkplaceProject: builder.mutation<
      CreateWorkplaceProjectResponse['projectId'],
      CreateWorkplaceProjectRequest & IdempotentMutationArgs
    >({
      queryFn: ({ idempotencyKey, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.workplace.projects.post(body, idempotencyOptions({ idempotencyKey })),
          (raw) => treatyJson(raw).projectId as ProjectId
        ),
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useCreateWorkplaceProjectMutation } = createWorkplaceProjectApi;
