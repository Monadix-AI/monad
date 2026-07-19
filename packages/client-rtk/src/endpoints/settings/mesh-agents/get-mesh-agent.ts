import type { GetMeshAgentResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMeshAgentsApi } from './list-mesh-agents.ts';

const getMeshAgentApi = listMeshAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshAgent: builder.query<GetMeshAgentResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.mesh.agents({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'MeshAgents', id: name }]
    })
  })
});

export const { useGetMeshAgentQuery } = getMeshAgentApi;
