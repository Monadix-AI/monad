import type { AtomDescriptor, AtomKind } from '@monad/protocol';
import type { AtomPackContext, ManifestAtomPack } from '@monad/sdk-atom';

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
  return {
    kind,
    id,
    ...(name && name !== id ? { name } : {}),
    ...(description ? { description } : {})
  };
}

export async function describeAtomPack(pack: ManifestAtomPack): Promise<AtomDescriptor[]> {
  const atoms: AtomDescriptor[] = [];
  const ctx: AtomPackContext = {
    registerConnector: (c) => atoms.push(toDescriptor('connector', c)),
    registerChannel: (c) => atoms.push(toDescriptor('channel', c)),
    registerCommand: (c) => atoms.push(toDescriptor('command', c)),
    registerMessageType: (m) => atoms.push(toDescriptor('message-type', m)),
    registerProvider: (p) => atoms.push(toDescriptor('provider', p)),
    registerHook: (h) => atoms.push(toDescriptor('hook', h)),
    registerAgentAdapter: (a) => atoms.push(toDescriptor('agent-adapter', a)),
    registerSandbox: (s) => atoms.push(toDescriptor('sandbox', s)),
    registerWorkspaceExperience: (e) => atoms.push(toDescriptor('workspace-experience', e)),
    registerWorkspaceExperienceApi: () => {},
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
