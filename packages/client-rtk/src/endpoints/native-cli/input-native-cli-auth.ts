import type { NativeCliInputRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface NativeCliInputArgs extends NativeCliInputRequest {
  id: string;
  controlToken: string;
}

const inputNativeCliAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inputNativeCliAuth: builder.mutation<OkResponse, NativeCliInputArgs>({
      queryFn: ({ id, controlToken, input }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).input.post({ input }, { query: { controlToken } })
        )
    })
  })
});

export const { useInputNativeCliAuthMutation } = inputNativeCliAuthApi;
