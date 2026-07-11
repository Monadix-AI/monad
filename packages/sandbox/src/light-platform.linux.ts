import type { SandboxLauncher } from '@monad/sdk-atom';

import { bwrapLauncher } from './launchers/bwrap.ts';
import { landlockLauncher } from './launchers/landlock.ts';

export const lightSandboxLaunchers: readonly SandboxLauncher[] = [bwrapLauncher, landlockLauncher];
