import type { SandboxLauncher } from '@monad/sdk-atom';

export interface LightSandboxPlatform {
  launchers: readonly SandboxLauncher[];
  sweepOrphanAppContainerProfiles(): Promise<void>;
}
