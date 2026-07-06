import type { MonadPaths } from '@monad/home';
import type { AtomDescriptor, WorkspaceExperienceDefinition } from '@monad/protocol';
import type { WorkspaceExperienceApiHandler } from '@monad/sdk-atom';
import type { AtomConflict } from '@/atoms/resolve.ts';
import type { RegisteredWorkspaceExperience } from '@/handlers/atom-pack/atom-pack-registry.ts';
import type { ConfigBus } from '@/services/config-bus.ts';
import type { ModelService } from '@/services/model.ts';

import { createMcpModule } from '@/handlers/atom-pack/atom-pack-mcp.ts';
import { createPacksModule } from '@/handlers/atom-pack/atom-pack-packs.ts';
import { createSkillsModule } from '@/handlers/atom-pack/atom-pack-skills.ts';

export interface AtomPacksDeps {
  paths: MonadPaths;
  /** Called after a successful install/remove so the daemon can re-discover atom packs (refresh
   *  the channel registry) without a restart. */
  onChanged?: () => Promise<void>;
  /** Bare-name collisions from the last load sweep — surfaced read-only for the conflict UI. */
  getConflicts?: () => AtomConflict[];
  /** Per-pack individual atoms (by pack folder name) from the last load sweep, for the detail view. */
  getAtomDetails?: (packName: string) => AtomDescriptor[] | undefined;
  /** Runtime-registered workspace experiences from loaded atom packs. */
  getWorkspaceExperiences?: () => RegisteredWorkspaceExperience[];
  /** Boot/rediscovery-built public workspace experience snapshot. */
  getWorkspaceExperienceSnapshot?: () => WorkspaceExperienceDefinition[] | undefined;
  /** Runtime-registered workspace experience API route resolver from loaded atom packs. */
  getWorkspaceExperienceApiHandler?: (
    experienceId: string,
    method: string,
    path: string
  ) => WorkspaceExperienceApiHandler | undefined;
  configBus?: ConfigBus;
  modelService?: ModelService;
}

export function createAtomPacksModule(deps: AtomPacksDeps) {
  return {
    ...createPacksModule(deps),
    ...createSkillsModule(deps),
    ...createMcpModule(deps)
  };
}
