import { MONAD_VERSION } from '@monad/protocol';

export function assertAtomPackMonadCompatibility(name: string, monadVersion: string | undefined): void {
  if (!monadVersion) return;
  const requirement = monadVersion.trim();
  if (!requirement) return;
  if (!Bun.semver.satisfies(MONAD_VERSION, requirement)) {
    throw new Error(`atom pack "${name}" requires monad ${requirement}, but running ${MONAD_VERSION}`);
  }
}
