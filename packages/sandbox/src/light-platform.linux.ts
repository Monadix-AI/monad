import type { LightSandboxPlatform } from './light-platform-contract.ts';

import { bwrapLauncher } from './launchers/bwrap.ts';
import { landlockLauncher } from './launchers/landlock.ts';

export const lightSandboxPlatform: LightSandboxPlatform = {
  launchers: [bwrapLauncher, landlockLauncher],
  async sweepOrphanAppContainerProfiles() {}
};
