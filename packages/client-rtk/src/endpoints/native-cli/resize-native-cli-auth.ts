import type { NativeCliResizeRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface NativeCliResizeArgs extends NativeCliResizeRequest {
  id: string;
  controlToken: string;
}

const resizeNativeCliAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resizeNativeCliAuth: builder.mutation<OkResponse, NativeCliResizeArgs>({
      queryFn: ({ id, controlToken, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['native-cli-auth-sessions']({ id })
            .resize.post({ cols, rows }, { query: { controlToken } })
        )
    })
  })
});

export const { useResizeNativeCliAuthMutation } = resizeNativeCliAuthApi;
