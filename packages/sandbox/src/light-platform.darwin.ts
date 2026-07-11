import type { SandboxLauncher } from '@monad/sdk-atom';

import { seatbeltLauncher } from './launchers/seatbelt.ts';

export const lightSandboxLaunchers: readonly SandboxLauncher[] = [seatbeltLauncher];
