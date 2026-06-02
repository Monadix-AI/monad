import type { HostPlatformModule } from './host-platform-contract.ts';

import { hostPlatformModule as darwin } from './host-platform.darwin.ts';
import { hostPlatformModule as linux } from './host-platform.linux.ts';
import { hostPlatformModule as windows } from './host-platform.windows.ts';

export const hostPlatformModule: HostPlatformModule = {
  current:
    process.platform === 'darwin' ? darwin.current : process.platform === 'win32' ? windows.current : linux.current,
  forPlatform(platform) {
    if (platform === 'darwin') return darwin.current;
    if (platform === 'win32') return windows.current;
    return linux.current;
  }
};
