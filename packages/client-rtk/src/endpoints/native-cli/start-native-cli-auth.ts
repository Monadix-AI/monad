import type { NativeCliAuthSessionView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const startNativeCliAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startNativeCliAuth: builder.mutation<NativeCliAuthSessionView, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-agents']({ name }).auth.start.post(),
          (raw) => raw.session
        )
    })
  })
});

export const { useStartNativeCliAuthMutation } = startNativeCliAuthApi;
