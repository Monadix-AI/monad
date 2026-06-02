import type { SessionOrigin, SessionOriginExt, SessionSurface, SessionTransport } from '@monad/protocol';

// Default write policy per surface. The orthogonal table is applied ONCE at creation to derive
// `writableBy`, which is then stored on the session — enforcement reads the stored policy, not
// this table (so a session's policy stays stable even if defaults change, and can be overridden).
const DEFAULT_WRITABLE_BY: Record<SessionSurface, SessionTransport[]> = {
  editor: ['acp'],
  im: ['channel'],
  web: ['http'],
  tui: ['http'],
  api: ['http'],
  automation: []
};

// Who may fork a session, by surface. Defaults match writableBy (only the owning transport), but the
// two are independent fields so a session can later be made forkable-from-anywhere or write-locked.
const DEFAULT_BRANCHABLE_BY: Record<SessionSurface, SessionTransport[]> = {
  editor: ['acp'],
  im: ['channel'],
  web: ['http'],
  tui: ['http'],
  api: ['http'],
  automation: []
};

export interface BuildOriginInput {
  transport: SessionTransport;
  surface: SessionSurface;
  client: string;
  clientVersion?: string;
  instanceId?: string;
  /** Explicit override of the surface-derived default write policy. */
  writableBy?: SessionTransport[];
  /** Explicit override of the surface-derived default branch (fork) policy. */
  branchableBy?: SessionTransport[];
  env?: SessionOrigin['env'];
  /** Open client-defined extension (bounded + validated by sessionOriginExtSchema). */
  ext?: SessionOriginExt;
}

/** Host OS as the SessionOrigin env enum, or undefined for unmapped platforms. */
export function hostOs(): NonNullable<SessionOrigin['env']>['os'] {
  switch (process.platform) {
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    default:
      return undefined;
  }
}

export function buildSessionOrigin(input: BuildOriginInput): SessionOrigin {
  return {
    surface: input.surface,
    client: input.client,
    clientVersion: input.clientVersion,
    instanceId: input.instanceId,
    transport: input.transport,
    writableBy: input.writableBy ?? DEFAULT_WRITABLE_BY[input.surface],
    branchableBy: input.branchableBy ?? DEFAULT_BRANCHABLE_BY[input.surface],
    env: input.env,
    ext: input.ext
  };
}
