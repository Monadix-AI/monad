import type { HostSandboxPlatform } from './sandbox-platform-contract.ts';

import { bwrapLauncher } from './launchers/bwrap.ts';
import { landlockLauncher } from './launchers/landlock.ts';
import { seatbeltLauncher } from './launchers/seatbelt.ts';
import { win32Launcher } from './launchers/win32.ts';
import { sweepOrphanAppContainerProfiles, win32AppContainerLauncher } from './launchers/win32-appcontainer.ts';

/** Development/test set. Release builds replace this module at resolution time. */
export const hostSandboxPlatform: HostSandboxPlatform = {
  launchers: [seatbeltLauncher, bwrapLauncher, landlockLauncher, win32AppContainerLauncher, win32Launcher],
  prepareHost: sweepOrphanAppContainerProfiles,
  async disposeHost() {}
};
