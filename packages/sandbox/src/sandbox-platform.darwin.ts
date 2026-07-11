import type { HostSandboxPlatform } from './sandbox-platform-contract.ts';

import { seatbeltLauncher } from './launchers/seatbelt.ts';

export const hostSandboxPlatform: HostSandboxPlatform = {
  launchers: [seatbeltLauncher],
  async prepareHost() {},
  async disposeHost() {}
};
