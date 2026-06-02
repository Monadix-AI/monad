export * from './context.ts';
export * from './dispatch.ts';
export * from './registry.ts';
export * from './session-commands.ts';

import type { RegistryLog } from './registry.ts';

import { CommandRegistry } from './registry.ts';

/** Build an EMPTY command registry. First-party built-ins are NOT seeded here — they arrive through
 *  the gated atom path (`builtinAtomPack`'s `command` atoms → onCommand → registerBuiltin), the same
 *  loader every other atom kind takes ("core is all atoms"). The daemon never reaches into the atom
 *  pack for `BUILTIN_COMMANDS`; tests that need the built-ins present without running the loader seed
 *  their own registry (see the `seededCommandRegistry` test helper). */
export function createCommandRegistry(log?: RegistryLog): CommandRegistry {
  return new CommandRegistry(log);
}
