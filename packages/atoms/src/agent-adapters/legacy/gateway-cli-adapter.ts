import type { MeshAgentAuthState, MeshAgentProductIcon, MeshAgentProvider, MeshAgentView } from '@monad/protocol';
import type { MeshAgentManagedRuntime, MeshAgentOutputEvent, MeshAgentProviderAdapter } from '@monad/sdk-atom';
import type {
  LegacyProviderApprovalResolution,
  LegacyProviderInitializeContext,
  LegacyProviderLaunchOptions,
  LegacyProviderLaunchSpec,
  LegacyProviderRuntimeHandle
} from './runtime.ts';

import { homedir } from 'node:os';
import { defaultBinProbes, MeshAgentError, resolveBinary } from '@monad/sdk-atom';

import { compactObject, hasFlag, parseStructuredAuthState } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { resizePty, sendPtyInput, stopPty } from '../pty.ts';
import { meshAgentAdapterSettings } from '../settings.ts';

// CLI-adapter boilerplate (detect/launch-args/auth-probes/pty+oneshot fallback) shared by every
// MeshAgent provider built from `makeGatewayCliAdapter`. Each provider's gateway wire protocol is
// hand-written per-provider (`GatewayCliHooks`, see openclaw/gateway and hermes/gateway) — OpenClaw's
// gateway wraps every frame in a bespoke `{type, id, ...}` envelope
// and Hermes wraps every notification as `{method:"event", params:{type,...}}`; neither is a generic
// JSON-RPC id/method/params/result/error shape a single shared dispatcher could serve both from.

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export interface GatewayCliHooks {
  initialize(handle: LegacyProviderRuntimeHandle, context: LegacyProviderInitializeContext): void;
  parseGatewayOutput(chunk: string, handle?: LegacyProviderRuntimeHandle): MeshAgentOutputEvent[];
  sendGatewayInput(handle: LegacyProviderRuntimeHandle, input: string): void;
  resolveGatewayApproval(handle: LegacyProviderRuntimeHandle, resolution: LegacyProviderApprovalResolution): void;
}

export interface MakeGatewayCliAdapterOptions {
  provider: MeshAgentProvider;
  productIcon: MeshAgentProductIcon;
  label: string;
  /** Binary name probed on PATH and used as the default command. */
  bin: string;
  /** Argv tokens that launch the persistent provider gateway (e.g. `['gateway', 'run',
   *  '--allow-unconfigured']` — OpenClaw's real gateway subcommand is two words plus a flag, not the
   *  bare `gateway` alias, which only prints usage and exits). OMIT for a provider with no real
   *  gateway backend (Hermes's older versions) — the gateway mode is then unavailable and
   *  `gatewayHooks` must also be omitted. */
  gatewaySubcommand?: string[];
  /** Fallback model ids advertised for `--model` (no models-list command). */
  models: string[];
  installHint: string;
  installUrl: string;
  /** Args used to launch an interactive provider-owned auth/setup flow. Defaults to `['auth']`. */
  authLaunchArgs?: string[];
  /** Args after `auth` for the auth-status probe (e.g. `['status']` vs `['list']`). */
  authStatusArgs: string[];
  /** Full args used for auth status when the provider does not expose status under `auth ...`. */
  authStatusLaunchArgs?: string[];
  /** Whether the auth-status probe appends `--json`. Default true; set FALSE for a provider whose
   *  `auth` subcommand rejects `--json` (Hermes) — else the probe errors and a signed-in agent is
   *  misreported as unauthenticated. The plain-text exit code (0 = authenticated) is used instead. */
  authStatusJson?: boolean;
  parseAuthStatus?(output: string, exitCode: number | null): MeshAgentAuthState;
  /** Managed project-agent runtime behavior; omit for a non-managed adapter. */
  managedRuntime?: MeshAgentManagedRuntime;
  /** Opt-in `cli-oneshot` launch mode for a provider with no persistent gateway backend (Hermes):
   *  the daemon spawns a fresh process per turn with `turnArgs(input)` appended to the base argv. */
  oneshot?: {
    turnArgs(input: string, opts: { providerSessionRef?: string | null }): string[];
  };
  /** The provider's gateway wire protocol. Required IFF `gatewaySubcommand` is set. */
  gatewayHooks?: GatewayCliHooks;
  /** `ws`-transport dial hints for a gateway that doesn't fit the daemon's default "scan the child's
   *  stderr for a self-announced `ws://host:port` line" strategy — e.g. one that prints a differently
   *  shaped announce line, serves at a non-root path, or needs query-string auth. */
  gatewayWs?: {
    /** URL path appended after `ws://host:port` (e.g. `/api/ws`). Root by default. */
    path?: string;
    /** CLI flag the gateway uses to accept an explicit port; only meaningful with
     *  `usesDaemonAssignedPort: true`. Defaults to `--port`. */
    portFlag?: string;
    /** When true, `buildLaunch` puts the daemon-assigned port (`opts.gatewayPort`) into argv via
     *  `portFlag` and echoes it back on the launch spec, so the daemon dials that exact port directly
     *  instead of scanning for a self-announced one — for a gateway whose announce line doesn't match
     *  (or isn't on) the generic `ws://host:port`-on-stderr pattern. */
    usesDaemonAssignedPort?: boolean;
    /** Query-string params built from the agent's config at launch time (e.g. a shared-secret token
     *  read from `agent.env`). */
    query?(agent: MeshAgentView): Record<string, string> | undefined;
  };
  /** The real CLI flag this provider accepts to bypass its own approval prompts (e.g. Hermes's
   *  `--yolo` — confirmed against its CLI reference: nousresearch/hermes-agent/website/docs/reference/
   *  cli-commands.md). OMIT for a provider with no such flag (OpenClaw — its own docs
   *  (docs.openclaw.ai/tools/exec-approvals) say explicitly "no single CLI flag or env var" bypasses
   *  approvals; it must be configured instead, via that adapter's `managedRuntime.env` writing
   *  `tools.exec.security`/`ask` into its own config + host-local approvals file). Omitting this never
   *  appends a flag — silently guessing a nonexistent one is worse than doing nothing. */
  skipApprovalFlag?: string;
}

/** Build a full `MeshAgentProviderAdapter` for a coding CLI whose legacy gateway mode is a
 *  persistent gateway process reached over WebSocket (OpenClaw, Hermes), plus pty/cli-oneshot
 *  fallbacks. */
type LegacyGatewayCliAdapter = Omit<MeshAgentProviderAdapter, 'events'> & {
  buildLaunch(agent: MeshAgentView, opts: LegacyProviderLaunchOptions): LegacyProviderLaunchSpec;
  initialize(handle: LegacyProviderRuntimeHandle, context: LegacyProviderInitializeContext): void;
  parseOutput(chunk: string, handle?: LegacyProviderRuntimeHandle): MeshAgentOutputEvent[];
  sendInput(handle: LegacyProviderRuntimeHandle, input: string): void;
  resolveApproval(handle: LegacyProviderRuntimeHandle, resolution: LegacyProviderApprovalResolution): void;
  resize(handle: LegacyProviderRuntimeHandle, cols: number, rows: number): void;
  stop(handle: LegacyProviderRuntimeHandle): void;
  oneshotTurnArgs?(input: string, opts: { providerSessionRef?: string | null }): string[];
  usesDaemonAssignedGatewayPort?: boolean;
};

export function makeGatewayCliAdapter(options: MakeGatewayCliAdapterOptions): LegacyGatewayCliAdapter {
  const gatewayTransports = ['ws'] as const;

  function skipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
    if (!skipProviderApprovals || !options.skipApprovalFlag || hasFlag(args, options.skipApprovalFlag)) return args;
    return [...args, options.skipApprovalFlag];
  }

  function buildLaunch(agent: MeshAgentView, opts: LegacyProviderLaunchOptions): LegacyProviderLaunchSpec {
    const launchMode =
      opts.launchMode ?? (options.gatewaySubcommand ? 'gateway' : options.oneshot ? 'cli-oneshot' : 'pty');
    let args = [...(agent.args ?? [])];
    if (opts.providerSessionRef && !hasFlag(args, '--session-id')) {
      args.push('--session-id', opts.providerSessionRef);
    }
    const modelId = opts.modelId ?? opts.modelName;
    if (modelId && !hasFlag(args, '--model')) args.push('--model', modelId);
    args = skipApprovalArgs(args, !!opts.skipProviderApprovals);

    if (launchMode === 'gateway') {
      if (!options.gatewaySubcommand) {
        throw new MeshAgentError('unsupported_capability', `${options.label} has no gateway backend`);
      }
      const transport = opts.gatewayTransport ?? 'ws';
      if (!(gatewayTransports as readonly string[]).includes(transport)) {
        throw new MeshAgentError(
          'unsupported_capability',
          `${options.label} gateway transport "${transport}" is not supported; use ${gatewayTransports.join(' or ')}`
        );
      }
      const usesDaemonPort = options.gatewayWs?.usesDaemonAssignedPort && opts.gatewayPort !== undefined;
      const portArgs = usesDaemonPort ? [options.gatewayWs?.portFlag ?? '--port', String(opts.gatewayPort)] : [];
      return {
        argv: [agent.command, ...(options.gatewaySubcommand ?? []), ...portArgs, ...args],
        cwd: opts.workingPath,
        env: agent.env,
        launchMode,
        gatewayTransport: transport,
        gatewayWs: options.gatewayWs
          ? compactObject({
              path: options.gatewayWs.path,
              query: options.gatewayWs.query?.(agent),
              port: usesDaemonPort ? opts.gatewayPort : undefined
            })
          : undefined,
        provider: options.provider,
        approvalOwnership: 'provider-owned',
        capabilities: ['gateway', 'provider-approval', 'approval-resolution', 'session-resume']
      };
    }

    if (launchMode === 'cli-oneshot') {
      if (!options.oneshot) {
        throw new MeshAgentError('unsupported_capability', `${options.label} has no cli-oneshot launch mode`);
      }
      // Base argv only — the per-turn directive is appended by the daemon via `oneshotTurnArgs`. Each
      // turn is a stateless fresh process (no --resume selector), so no `session-resume` capability.
      return {
        argv: [agent.command, ...args],
        cwd: opts.workingPath,
        env: agent.env,
        launchMode,
        provider: options.provider,
        approvalOwnership: 'provider-owned',
        capabilities: ['cli-oneshot']
      };
    }

    return {
      argv: [agent.command, ...args],
      cwd: opts.workingPath,
      env: agent.env,
      launchMode,
      provider: options.provider,
      approvalOwnership: 'provider-owned',
      capabilities: options.gatewaySubcommand
        ? ['pty', 'gateway', 'provider-approval', 'session-resume']
        : ['pty', 'provider-approval']
    };
  }

  function buildAuthLaunch(agent: MeshAgentView, args: string[]): LegacyProviderLaunchSpec {
    return {
      argv: [agent.command, ...args],
      cwd: homedir(),
      env: agent.env,
      launchMode: 'pty',
      provider: options.provider,
      approvalOwnership: 'provider-owned',
      capabilities: ['pty', 'provider-approval']
    };
  }

  function parseTerminalOutput(chunk: string): MeshAgentOutputEvent[] {
    return chunk.length > 0 ? [{ type: 'agent_message', payload: { text: chunk } }] : [];
  }

  const adapter: LegacyGatewayCliAdapter = {
    provider: options.provider,
    productIcon: options.productIcon,
    label: options.label,
    settings: () => meshAgentAdapterSettings(),
    ...(options.managedRuntime ? { managedRuntime: options.managedRuntime } : {}),
    ...(options.oneshot ? { oneshotTurnArgs: options.oneshot.turnArgs } : {}),
    ...(options.gatewayWs?.usesDaemonAssignedPort ? { usesDaemonAssignedGatewayPort: true } : {}),
    detect(probes = defaultBinProbes) {
      const bin = resolveBinary(options.bin, [], probes);
      const installed = bin !== undefined;
      return {
        id: options.provider,
        label: options.label,
        provider: options.provider,
        productIcon: options.productIcon,
        command: options.bin,
        args: [],
        modelOptions: adapter.listSupportedModels(),
        settings: adapter.settings?.(),
        installHint: options.installHint,
        installUrl: options.installUrl,
        installed,
        resolvedBinPath: bin,
        capabilities: {
          auth: 'pty',
          events: 'none',
          resume: 'pty',
          approval: 'provider-owned'
        }
      };
    },
    resolveCommand(command, probes = defaultBinProbes) {
      return resolveBinary(command, [], probes);
    },
    listSupportedModels(agent) {
      return agent?.modelOptions?.length ? agent.modelOptions : options.models;
    },
    buildLaunch,
    buildAuthLaunch(agent) {
      return buildAuthLaunch(agent, options.authLaunchArgs ?? ['auth']);
    },
    buildAuthStatusLaunch(agent) {
      return buildAuthLaunch(agent, options.authStatusLaunchArgs ?? ['auth', ...options.authStatusArgs]);
    },
    authStatus(agent) {
      const jsonArg = options.authStatusJson === false ? [] : ['--json'];
      const args = options.authStatusLaunchArgs ?? ['auth', ...options.authStatusArgs, ...jsonArg];
      return {
        launch: buildAuthLaunch(agent, args),
        parse: (output, exitCode) => adapter.parseAuthStatus(output, exitCode)
      };
    },
    argumentSupport(agent) {
      return {
        launch: buildAuthLaunch(agent, ['--help']),
        parse: (output) => parseMeshAgentArgumentSupport(output)
      };
    },
    parseAuthStatus(output, exitCode) {
      if (options.parseAuthStatus) return options.parseAuthStatus(output, exitCode);
      const structured = parseStructuredAuthState(output);
      if (structured) return structured;
      if (exitCode === 0) return 'authenticated';
      if (exitCode !== null) return 'unauthenticated';
      return 'unknown';
    },
    initialize(handle, context) {
      options.gatewayHooks?.initialize(handle, context);
    },
    parseOutput(chunk, handle) {
      if (handle?.launchMode !== 'gateway' || !options.gatewayHooks) return parseTerminalOutput(chunk);
      return options.gatewayHooks.parseGatewayOutput(chunk, handle);
    },
    sendInput(handle, input) {
      if (handle.launchMode === 'gateway' && options.gatewayHooks) {
        options.gatewayHooks.sendGatewayInput(handle, input);
        return;
      }
      sendPtyInput(handle, input);
    },
    resolveApproval(handle, resolution) {
      if (handle.launchMode !== 'gateway') {
        throw new Error(`${options.label} MeshAgent approval resolution is provider-owned in pty mode`);
      }
      options.gatewayHooks?.resolveGatewayApproval(handle, resolution);
    },
    resize(handle, cols, rows) {
      if (handle.launchMode === 'gateway') return;
      resizePty(handle, cols, rows);
    },
    stop(handle) {
      if (handle.launchMode === 'gateway') {
        handle.gateway?.close();
        handle.kill('SIGTERM');
        return;
      }
      stopPty(handle);
    }
  };
  return adapter;
}
