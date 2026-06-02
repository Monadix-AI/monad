import type {
  ImportInventoryOpenLocationRequest,
  ImportInventoryOpenLocationResponse,
  ImportInventoryResponse
} from '@monad/protocol';

import { importInventoryOpenLocationResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty, toError } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const importInventoryApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getImportInventory: builder.query<ImportInventoryResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.import.inventory.get()),
      providesTags: ['ImportInventory']
    }),
    openImportInventoryLocation: builder.mutation<
      ImportInventoryOpenLocationResponse,
      ImportInventoryOpenLocationRequest
    >({
      queryFn: async (body, api: { extra: unknown }) => {
        try {
          const res = await clientOf(api).fetch('/v1/settings/import/inventory/open-location', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
          const responseBody = await res.json().catch(() => ({}));
          if (!res.ok) return { error: toError({ status: res.status, value: responseBody }) };
          return { data: importInventoryOpenLocationResponseSchema.parse(responseBody) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useGetImportInventoryQuery, useOpenImportInventoryLocationMutation } = importInventoryApi;
