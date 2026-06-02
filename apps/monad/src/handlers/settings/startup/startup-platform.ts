import type { StartupPlatformModule } from './startup-platform-contract.ts';

import { startupPlatformModule as darwin } from './startup-platform.darwin.ts';
import { startupPlatformModule as linux } from './startup-platform.linux.ts';
import { startupPlatformModule as windows } from './startup-platform.windows.ts';

export const startupPlatformModule: StartupPlatformModule = {
  current:
    process.platform === 'darwin' ? darwin.current : process.platform === 'win32' ? windows.current : linux.current,
  forPlatform(platform) {
    if (platform === 'darwin') return darwin.current;
    if (platform === 'linux') return linux.current;
    if (platform === 'win32') return windows.current;
    return null;
  }
};
