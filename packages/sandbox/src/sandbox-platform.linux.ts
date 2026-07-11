import type { HostSandboxPlatform } from './sandbox-platform-contract.ts';

import { bwrapLauncher } from './launchers/bwrap.ts';
import { landlockLauncher } from './launchers/landlock.ts';

export const hostSandboxPlatform: HostSandboxPlatform = {
  launchers: [bwrapLauncher, landlockLauncher],
  async prepareHost() {},
  async disposeHost() {}
};
