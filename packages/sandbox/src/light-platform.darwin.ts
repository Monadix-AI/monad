import type { LightSandboxPlatform } from './light-platform-contract.ts';

import { seatbeltLauncher } from './launchers/seatbelt.ts';

export const lightSandboxPlatform: LightSandboxPlatform = {
  launchers: [seatbeltLauncher],
  async sweepOrphanAppContainerProfiles() {}
};
