import type { SandboxLauncher } from '@monad/sdk-atom';

export interface HostSandboxPlatform {
  launchers: readonly SandboxLauncher[];
  prepareHost(): Promise<void>;
  disposeHost(): Promise<void>;
}
