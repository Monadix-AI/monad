import type { InitDockerResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getToolBackendsApi } from './get-tool-backends.ts';

const initDockerApi = getToolBackendsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    initDockerBackend: builder.mutation<InitDockerResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => {
        const initDocker = clientOf(api).treaty.v1.settings['tool-backends']['init-docker'].post;
        return runTreaty(() => initDocker());
      }
    })
  })
});

export const { useInitDockerBackendMutation } = initDockerApi;
