import type { LightSandboxPlatform } from './light-platform-contract.ts';

import { win32Launcher } from './launchers/win32.ts';
import { sweepOrphanAppContainerProfiles, win32AppContainerLauncher } from './launchers/win32-appcontainer.ts';

export const lightSandboxPlatform: LightSandboxPlatform = {
  launchers: [win32AppContainerLauncher, win32Launcher],
  sweepOrphanAppContainerProfiles
};
