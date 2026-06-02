import type { MonadPaths } from '@monad/environment';
import type { AtomDescriptor, WorkplaceExperienceDefinition } from '@monad/protocol';
import type { WorkplaceExperienceApiHandler } from '@monad/sdk-atom';
import type { AtomConflict } from '#/atoms/resolve.ts';
import type { ConfigAccess } from '#/config/manager.ts';
import type {
  RegisteredWorkplaceExperience,
  RegisteredWorkplaceExperienceApiRoute
} from '#/handlers/atom-pack/atom-pack-registry.ts';
import type { ExperienceCapabilityDeps } from '#/handlers/atom-pack/experience-capabilities.ts';
import type { SandboxActivationService } from '#/platform/sandbox/activation.ts';
import type { ModelService } from '#/services/model.ts';

import { createMcpModule } from '#/handlers/atom-pack/atom-pack-mcp.ts';
import { createPacksModule } from '#/handlers/atom-pack/atom-pack-packs.ts';
import { createSkillsModule } from '#/handlers/atom-pack/atom-pack-skills.ts';

export interface AtomPacksDeps {
  paths: MonadPaths;
  experienceCapabilities?: ExperienceCapabilityDeps;
  /** Called after a successful install/remove so the daemon can re-discover atom packs (refresh
   *  the channel registry) without a restart. */
  onChanged?: () => Promise<void>;
  /** Bare-name collisions from the last load sweep — surfaced read-only for the conflict UI. */
  getConflicts?: () => AtomConflict[];
  /** Per-pack individual atoms (by pack folder name) from the last load sweep, for the detail view. */
  getAtomDetails?: (packName: string) => AtomDescriptor[] | undefined;
  /** Runtime-registered workplace experiences from loaded atom packs. */
  getWorkplaceExperiences?: () => RegisteredWorkplaceExperience[];
  /** Boot/rediscovery-built public workplace experience snapshot. */
  getWorkplaceExperienceSnapshot?: () => WorkplaceExperienceDefinition[] | undefined;
  /** Runtime-registered workplace experience API route resolver from loaded atom packs. */
  getWorkplaceExperienceApiHandler?: (
    experienceId: string,
    method: string,
    path: string
  ) => WorkplaceExperienceApiHandler | undefined;
  getWorkplaceExperienceApiRoute?: (
    experienceId: string,
    method: string,
    path: string
  ) => RegisteredWorkplaceExperienceApiRoute | undefined;
  config?: ConfigAccess;
  sandboxActivation?: SandboxActivationService;
  modelService?: ModelService;
}

export function createAtomPacksModule(deps: AtomPacksDeps) {
  return {
    ...createPacksModule(deps),
    ...createSkillsModule(deps),
    ...createMcpModule(deps)
  };
}
