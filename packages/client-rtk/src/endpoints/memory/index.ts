import type {
  AddMemoryFactRequest,
  EditMemoryFactRequest,
  Fact,
  ForgetMemoryFactRequest,
  ListMemoryFactsResponse,
  MemoryBackendId,
  MemoryCoreResponse,
  MemoryScopeQuery,
  MemoryStatusResponse,
  PutMemoryCoreRequest
} from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// L1 layered-memory control API: list/add/edit/forget machine + user facts per scope
// (global/agent/session), plus read/overwrite a scope's raw MEMORY.md. Backs the Memory settings tab.
export const memoryApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMemoryStatus: builder.query<MemoryStatusResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.status.get()),
      providesTags: ['Memory']
    }),
    setMemoryBackend: builder.mutation<{ ok: boolean }, { backend: MemoryBackendId }>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.backend.put(body)),
      invalidatesTags: ['Memory']
    }),
    setMem0Models: builder.mutation<
      { ok: boolean },
      { llm?: string | null; embedder?: string | null; embedDim?: number | null }
    >({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.mem0.models.put(body)),
      invalidatesTags: ['Memory']
    }),
    listMemoryFacts: builder.query<Fact[], MemoryScopeQuery>({
      queryFn: (arg: MemoryScopeQuery, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.memory.facts.get({ query: arg }),
          (raw: ListMemoryFactsResponse) => raw.facts
        ),
      providesTags: ['Memory']
    }),
    getMemoryCore: builder.query<MemoryCoreResponse, MemoryScopeQuery>({
      queryFn: (arg: MemoryScopeQuery, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.memory.core.get({ query: arg })),
      providesTags: ['Memory']
    }),
    putMemoryCore: builder.mutation<{ ok: boolean }, PutMemoryCoreRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.core.put(body)),
      invalidatesTags: ['Memory']
    }),
    addMemoryFact: builder.mutation<{ fact: Fact }, AddMemoryFactRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.facts.post(body)),
      invalidatesTags: ['Memory']
    }),
    editMemoryFact: builder.mutation<{ fact: Fact }, EditMemoryFactRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.facts.patch(body)),
      invalidatesTags: ['Memory']
    }),
    forgetMemoryFact: builder.mutation<{ ok: boolean }, ForgetMemoryFactRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.facts.delete(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const {
  useGetMemoryStatusQuery,
  useSetMemoryBackendMutation,
  useSetMem0ModelsMutation,
  useListMemoryFactsQuery,
  useGetMemoryCoreQuery,
  usePutMemoryCoreMutation,
  useAddMemoryFactMutation,
  useEditMemoryFactMutation,
  useForgetMemoryFactMutation
} = memoryApi;
