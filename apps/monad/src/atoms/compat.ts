import { MONAD_VERSION } from '@monad/protocol';
import { SDK_VERSION } from '@monad/sdk-atom';

export function assertAtomPackSdkCompatibility(name: string, requirement: string, sdkVersion = SDK_VERSION): void {
  // Legacy manifests used the contract epoch "0" before sdkVersion became a semver range. Keep
  // them compatible with the 0.1 line without silently carrying them across a future 0.2 break.
  const range = requirement === '0' ? '>=0.1.0 <0.2.0' : requirement;
  if (!Bun.semver.satisfies(sdkVersion, range)) {
    throw new Error(`Atom Pack "${name}" requires sdkVersion ${requirement}, but running ${sdkVersion}`);
  }
}

export function assertAtomPackMonadCompatibility(name: string, monadVersion: string | undefined): void {
  if (!monadVersion) return;
  const requirement = monadVersion.trim();
  if (!requirement) return;
  if (!Bun.semver.satisfies(MONAD_VERSION, requirement)) {
    throw new Error(`Atom Pack "${name}" requires Monad ${requirement}, but running ${MONAD_VERSION}`);
  }
}
