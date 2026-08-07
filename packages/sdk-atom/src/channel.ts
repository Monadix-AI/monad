// Channel authoring surface — the `channel` atom of the unified atom pack SDK. A channel
// lets an external IM platform reach the agent. Deliberately NARROW: the adapter only does
// platform I/O. Its ChannelContext has NO handlers/store/sessionId/agent-Event, so it
// cannot create/select/enumerate sessions or reach the agent's tools or credential vault outside
// its own host-provided state directory.
//
// Lives in @monad/sdk-atom (not a separate package) so an atom pack author has ONE SDK import and
// AtomPackContext.registerChannel can be fully typed against ChannelDefinition without a dep cycle.

import type {
  ChannelCapabilities,
  ChannelConnectionMode,
  ChannelEnvVar,
  ChannelIcon,
  ChannelInbound,
  ChannelManifest,
  ChannelSetupGuide,
  ChannelType,
  CommandArg,
  CommandSubcommand
} from '@monad/protocol';

import { channelInboundSchema, channelManifestSchema } from '@monad/protocol';

export type {
  ChannelCapabilities,
  ChannelConnectionMode,
  ChannelEnvVar,
  ChannelIcon,
  ChannelInbound,
  ChannelManifest,
  ChannelSetupGuide,
  ChannelType
};

/** The slice of channel config the atom pack may see — only what it needs to run. Host-only
 *  concerns (conversation mapping and credentials) are deliberately withheld. */
export interface ChannelAtomConfig {
  id: string;
  type: ChannelType;
  label: string;
  connectedWelcome?: string;
}

/** A handle to one already-delivered message, for streaming edits. Opaque to the core. */
export interface SentMessage {
  ref: string;
  chatId: string;
  threadId?: string;
}

export interface SendOptions {
  replyTo?: string;
  threadId?: string;
  /** Free-form adapter hints (parse mode, silent, …). Never secrets. */
  metadata?: Record<string, unknown>;
}

/** Platform-neutral command metadata pushed to adapters with a native command surface. The adapter
 * maps this discovery shape onto the platform's registration API; execution remains host-owned. */
export interface ChannelNativeCommand {
  command: string;
  description: string;
  args?: CommandArg[];
  subcommands?: CommandSubcommand[];
}

export type ChannelLog = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

export interface ChannelProcessHandle {
  readonly pid?: number;
  readonly exited?: Promise<unknown>;
  kill?(signal?: number | string): void;
}

/** Injected once at construction. The narrow capability surface IS the security boundary. */
export interface ChannelContext {
  /** The adapter calls this for every inbound native event it normalizes. */
  onMessage: (msg: ChannelInbound) => void;
  /** Secret-redacting logger scoped to this channel instance. */
  log: ChannelLog;
  /** Resolved, non-secret config for this channel instance. */
  config: ChannelAtomConfig;
  /** Credential material (token etc.) narrowed from the owning channel setting. */
  secrets: Record<string, string>;
  /** Cooperative shutdown signal. */
  signal: AbortSignal;
  /** Host-owned directory scoped to this instance for opaque platform session state. */
  stateDir?: string;
  /** Report transport state without exposing adapter credentials to the host. */
  onStatus?: (status: ChannelRuntimeStatus) => void;
  /** Host-owned process tracker for adapter child processes. Optional so older hosts stay compatible. */
  trackProcess?: (process: ChannelProcessHandle, label?: string) => void;
}

export interface ChannelRuntimeStatus {
  phase: 'connecting' | 'pairing' | 'connected' | 'disconnected' | 'error';
  pairingQr?: string;
  error?: string;
}

export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Revoke a paired platform session before deleting local state. */
  logout?(): Promise<void>;
  send(chatId: string, content: string, opts?: SendOptions): Promise<SentMessage>;
  editMessage?(msg: SentMessage, content: string): Promise<void>;
  startTyping?(chatId: string, threadId?: string): Promise<void>;
  /** Push the slash-command list to the platform's native command menu (optional).
   *  Called once after connect() with all registered host commands. Failures are non-fatal. */
  setCommands?(commands: ChannelNativeCommand[]): Promise<void>;
  /** React to a message with an emoji (optional; gated by capabilities.reactions). Used to
   *  acknowledge a host command (e.g. ✅) — feedback even when the command has no text reply. */
  react?(target: { chatId: string; messageId: string }, emoji: string): Promise<void>;
}

export interface ChannelAdapterFactory {
  (ctx: ChannelContext): ChannelAdapter;
  connectionMode?: ChannelConnectionMode;
}

/** The declarative channel definition an author exports and registers via
 *  `ctx.registerChannel(def)`. The host reads `type`/`name`/`capabilities`/`envVars` for cheap
 *  metadata and calls `create(ctx)` to build the adapter. */
export interface ChannelDefinition {
  type: ChannelType;
  name: string;
  capabilities: ChannelCapabilities;
  envVars?: ChannelEnvVar[];
  icon: ChannelIcon;
  setup?: ChannelSetupGuide;
  connectionMode?: ChannelConnectionMode;
  create: ChannelAdapterFactory;
}

/** Identity helper — pins the ChannelDefinition shape at authoring time for type inference. */
export function defineChannel(def: ChannelDefinition): ChannelDefinition {
  def.create.connectionMode = def.connectionMode ?? 'credential';
  return def;
}

/** Parse + validate a channel manifest (untrusted input read off disk). */
export function parseChannelManifest(raw: unknown): ChannelManifest {
  return channelManifestSchema.parse(raw);
}

export interface ChannelTestHarness {
  adapter: ChannelAdapter;
  ctx: ChannelContext;
  /** Everything the adapter pushed up via ctx.onMessage. */
  received: ChannelInbound[];
  logs: { level: 'info' | 'warn' | 'error'; msg: string }[];
  /** Abort the adapter's signal (simulates disconnect/shutdown). */
  dispose(): void;
}

export interface ChannelHarnessOptions {
  config?: Partial<ChannelAtomConfig>;
  secrets?: Record<string, string>;
}

export function createChannelTestHarness(
  target: ChannelDefinition | ChannelAdapterFactory,
  opts: ChannelHarnessOptions = {}
): ChannelTestHarness {
  const received: ChannelInbound[] = [];
  const logs: { level: 'info' | 'warn' | 'error'; msg: string }[] = [];
  const abort = new AbortController();

  const config: ChannelAtomConfig = {
    id: 'chn_TESTHARNESS0',
    type: 'test',
    label: 'Test',
    ...opts.config
  };

  const ctx: ChannelContext = {
    onMessage: (msg) => {
      received.push(msg);
    },
    log: (level, msg) => {
      logs.push({ level, msg });
    },
    config,
    secrets: opts.secrets ?? {},
    signal: abort.signal
  };

  const factory: ChannelAdapterFactory = typeof target === 'function' ? target : target.create;
  const adapter = factory(ctx);

  return { adapter, ctx, received, logs, dispose: () => abort.abort() };
}

/** Validate that an object is a well-formed normalized inbound event (throws otherwise). */
export function assertChannelInbound(value: unknown): ChannelInbound {
  return channelInboundSchema.parse(value);
}
