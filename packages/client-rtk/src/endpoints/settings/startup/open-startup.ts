import type { OpenStartupSettingsResponse } from '@monad/protocol';

import { openStartupSettingsResponseSchema } from '@monad/protocol';

import { clientOf, toError } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const openStartupApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    openStartupSettings: builder.mutation<OpenStartupSettingsResponse, void>({
      queryFn: async (_arg, api: { extra: unknown }) => {
        try {
          const res = await clientOf(api).fetch('/v1/settings/startup/open', { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) return { error: toError({ status: res.status, value: body }) };
          return { data: openStartupSettingsResponseSchema.parse(body) };
        } catch (error) {
          return { error: toError(error) };
        }
      }
    })
  })
});

export const { useOpenStartupSettingsMutation } = openStartupApi;
