import type { ModelDeps } from '#/handlers/settings/model/context.ts';

import { createModelContext } from '#/handlers/settings/model/context.ts';
import { createAtomKindsHandlers } from '#/handlers/settings/model/handlers/atom-kinds.ts';
import { createCredentialsHandlers } from '#/handlers/settings/model/handlers/credentials.ts';
import { createProfilesHandlers } from '#/handlers/settings/model/handlers/profiles.ts';
import { createProvidersHandlers } from '#/handlers/settings/model/handlers/providers.ts';
import { createTranscriptionHandlers } from '#/handlers/settings/model/handlers/transcription.ts';

export type { ModelDeps } from '#/handlers/settings/model/context.ts';

export { ModelService } from '#/services/model.ts';

export function createModelModule(deps: ModelDeps) {
  const ctx = createModelContext(deps);

  return Object.assign(
    createProvidersHandlers(ctx),
    createProfilesHandlers(ctx),
    createCredentialsHandlers(ctx),
    createTranscriptionHandlers(ctx, deps),
    createAtomKindsHandlers(deps.paths.providers, deps.modelService)
  );
}
