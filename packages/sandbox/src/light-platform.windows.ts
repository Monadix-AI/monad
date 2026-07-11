import type { SandboxLauncher } from '@monad/sdk-atom';

import { win32Launcher } from './launchers/win32.ts';
import { win32AppContainerLauncher } from './launchers/win32-appcontainer.ts';

export const lightSandboxLaunchers: readonly SandboxLauncher[] = [win32AppContainerLauncher, win32Launcher];
