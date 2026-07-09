import type {
  CapabilityInventoryOpenLocationRequest,
  CapabilityInventoryOpenLocationResponse,
  CapabilityInventoryResponse
} from '@monad/protocol';

import { capabilityInventoryOpenLocationResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty, toError } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const capabilityInventoryApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getCapabilityInventory: builder.query<CapabilityInventoryResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['capability-inventory'].get()),
      providesTags: ['CapabilityInventory']
    }),
    openCapabilityInventoryLocation: builder.mutation<
      CapabilityInventoryOpenLocationResponse,
      CapabilityInventoryOpenLocationRequest
    >({
      queryFn: async (body, api: { extra: unknown }) => {
        try {
          const res = await clientOf(api).fetch('/v1/settings/capability-inventory/open-location', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
          const responseBody = await res.json().catch(() => ({}));
          if (!res.ok) return { error: toError({ status: res.status, value: responseBody }) };
          return { data: capabilityInventoryOpenLocationResponseSchema.parse(responseBody) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useGetCapabilityInventoryQuery, useOpenCapabilityInventoryLocationMutation } = capabilityInventoryApi;
