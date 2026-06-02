import type { HostSandboxPlatform } from './sandbox-platform-contract.ts';

import { win32Launcher } from './launchers/win32.ts';
import { sweepOrphanAppContainerProfiles, win32AppContainerLauncher } from './launchers/win32-appcontainer.ts';

export const hostSandboxPlatform: HostSandboxPlatform = {
  launchers: [win32AppContainerLauncher, win32Launcher],
  prepareHost: sweepOrphanAppContainerProfiles,
  async disposeHost() {}
};
