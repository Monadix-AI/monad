import type { AtomDescriptor, AtomKind } from '@monad/protocol';
import type { AtomPackContext, ManifestAtomPack } from '@monad/sdk-atom';

import {
  channelCapabilitiesSchema,
  channelConnectionModeSchema,
  channelEnvVarSchema,
  channelIconSchema,
  channelSetupGuideSchema
} from '@monad/protocol';

// Enumerate a pack's individual atoms by running its `register()` against a collecting context
// instead of the real host registries. defineAtomPack's register only forwards each atom to a
// `ctx.registerX` call, so this harvests every atom (kind + id + name + description) with no real
// side effects. Used for the built-in pack's detail view; a hand-written pack whose register does
// more than forward is described best-effort (errors are swallowed and it falls back to its kinds).

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toDescriptor(kind: AtomKind, atom: unknown): AtomDescriptor {
  const o = (atom ?? {}) as Record<string, unknown>;
  const descriptor = (o.descriptor ?? {}) as Record<string, unknown>;
  const id =
    str(o.id) ??
    str(o.type) ??
    str(o.kind) ??
    str(o.provider) ??
    str(o.name) ??
    str(o.event) ??
    str(descriptor.type) ??
    'unknown';
  const name = str(o.name) ?? str(o.label) ?? str(o.title) ?? str(descriptor.label) ?? str(descriptor.name);
  const description = str(o.description) ?? str(descriptor.description);
  const parsedIcon = channelIconSchema.safeParse(o.icon ?? descriptor.icon);
  const channel =
    kind === 'channel'
      ? {
          ...(() => {
            const capabilities = channelCapabilitiesSchema.safeParse(o.capabilities);
            return capabilities.success ? { capabilities: capabilities.data } : {};
          })(),
          envVars: Array.isArray(o.envVars)
            ? o.envVars.flatMap((envVar) => {
                const parsed = channelEnvVarSchema.safeParse(envVar);
                return parsed.success ? [parsed.data] : [];
              })
            : [],
          ...(() => {
            const icon = channelIconSchema.safeParse(o.icon);
            return icon.success ? { icon: icon.data } : {};
          })(),
          ...(() => {
            const setup = channelSetupGuideSchema.safeParse(o.setup);
            return setup.success ? { setup: setup.data } : {};
          })(),
          ...(() => {
            const connectionMode = channelConnectionModeSchema.safeParse(o.connectionMode);
            return connectionMode.success ? { connectionMode: connectionMode.data } : {};
          })()
        }
      : undefined;
  return {
    kind,
    id,
    ...(name && name !== id ? { name } : {}),
    ...(description ? { description } : {}),
    ...(parsedIcon.success ? { icon: parsedIcon.data } : {}),
    ...(channel ? { channel } : {})
  };
}

export async function describeAtomPack(pack: ManifestAtomPack): Promise<AtomDescriptor[]> {
  const atoms: AtomDescriptor[] = [];
  const ctx: AtomPackContext = {
    registerChannel: (c) => atoms.push(toDescriptor('channel', c)),
    registerCommand: (c) => atoms.push(toDescriptor('command', c)),
    registerMessageType: (m) => atoms.push(toDescriptor('message-type', m)),
    registerProvider: (p) => atoms.push(toDescriptor('provider', p)),
    registerHook: (h) => atoms.push(toDescriptor('hook', h)),
    registerAgentAdapter: (a) => atoms.push(toDescriptor('agent-adapter', a)),
    registerSandbox: (s) => atoms.push(toDescriptor('sandbox', s)),
    registerWorkplaceExperience: (e) => atoms.push(toDescriptor('workplace-experience', e)),
    registerWorkplaceExperienceApi: () => {},
    registerExperienceWorker: () => {},
    requestInteraction: () => Promise.resolve({ status: 'cancelled', reason: 'unavailable' }),
    log: () => {}
  };
  try {
    await pack.register(ctx);
  } catch {
    /* best-effort: a pack whose register() does more than forward atoms falls back to its kinds */
  }
  return atoms;
}
