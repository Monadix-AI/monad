import type {
  ExternalAgentAuthState,
  ExternalAgentProductIcon,
  ExternalAgentProvider,
  ExternalAgentView
} from '@monad/protocol';
import type {
  BuildExternalAgentLaunchOptions,
  ExternalAgentLaunchSpec,
  ExternalAgentManagedRuntime,
  ExternalAgentOutputEvent,
  ExternalAgentProviderAdapter,
  ExternalAgentRuntimeHandle
} from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { defaultBinProbes, ExternalAgentError, resolveBinary } from '@monad/sdk-atom';

import { compactObject, hasFlag, parseStructuredAuthState } from './adapter-shared.ts';
import { parseExternalAgentArgumentSupport } from './argument-support.ts';
import { resizePty, sendPtyInput, stopPty } from './pty.ts';
import { externalAgentAdapterSettings } from './settings.ts';

// CLI-adapter boilerplate (detect/launch-args/auth-probes/pty+oneshot fallback) shared by every
// external agent provider built from `makeAppServerCliAdapter`. Each provider's real app-server wire
// protocol is hand-written per-provider (`AppServerCliHooks`, see openclaw/app-server.ts and
// hermes/app-server.ts) — OpenClaw's gateway wraps every frame in a bespoke `{type, id, ...}` envelope
// and Hermes wraps every notification as `{method:"event", params:{type,...}}`; neither is a generic
// JSON-RPC id/method/params/result/error shape a single shared dispatcher could serve both from.

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Hand-written app-server wiring for a gateway whose wire envelope is provider-specific (OpenClaw,
 *  Hermes). Passed as `appServerHooks` to `makeAppServerCliAdapter`. */
export interface AppServerCliHooks {
  initialize(
    handle: ExternalAgentRuntimeHandle,
    context: Parameters<NonNullable<ExternalAgentProviderAdapter['initialize']>>[1]
  ): void;
  parseAppServerOutput(chunk: string, handle?: ExternalAgentRuntimeHandle): ExternalAgentOutputEvent[];
  sendAppServerInput(handle: ExternalAgentRuntimeHandle, input: string): void;
  resolveAppServerApproval(
    handle: ExternalAgentRuntimeHandle,
    resolution: Parameters<ExternalAgentProviderAdapter['resolveApproval']>[1]
  ): void;
}

export interface MakeAppServerCliAdapterOptions {
  provider: ExternalAgentProvider;
  productIcon: ExternalAgentProductIcon;
  label: string;
  /** Binary name probed on PATH and used as the default command. */
  bin: string;
  /** Argv tokens that launch the persistent app-server gateway (e.g. `['gateway', 'run',
   *  '--allow-unconfigured']` — OpenClaw's real gateway subcommand is two words plus a flag, not the
   *  bare `gateway` alias, which only prints usage and exits). OMIT for a provider with no real
   *  app-server backend (Hermes's older versions) — app-server is then not an offered launch mode and
   *  `appServerHooks` must also be omitted. */
  appServerSubcommand?: string[];
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
  parseAuthStatus?(output: string, exitCode: number | null): ExternalAgentAuthState;
  /** Managed project-agent runtime behavior; omit for a non-managed adapter. */
  managedRuntime?: ExternalAgentManagedRuntime;
  /** Opt-in `cli-oneshot` launch mode for a provider with no persistent app-server backend (Hermes):
   *  the daemon spawns a fresh process per turn with `turnArgs(input)` appended to the base argv. */
  oneshot?: {
    turnArgs(input: string, opts: { providerSessionRef?: string | null }): string[];
  };
  /** The provider's app-server wire protocol. Required IFF `appServerSubcommand` is set. */
  appServerHooks?: AppServerCliHooks;
  /** `ws`-transport dial hints for a gateway that doesn't fit the daemon's default "scan the child's
   *  stderr for a self-announced `ws://host:port` line" strategy — e.g. one that prints a differently
   *  shaped announce line, serves at a non-root path, or needs query-string auth. */
  appServerWs?: {
    /** URL path appended after `ws://host:port` (e.g. `/api/ws`). Root by default. */
    path?: string;
    /** CLI flag the gateway uses to accept an explicit port; only meaningful with
     *  `usesDaemonAssignedPort: true`. Defaults to `--port`. */
    portFlag?: string;
    /** When true, `buildLaunch` puts the daemon-assigned port (`opts.appServerPort`) into argv via
     *  `portFlag` and echoes it back on the launch spec, so the daemon dials that exact port directly
     *  instead of scanning for a self-announced one — for a gateway whose announce line doesn't match
     *  (or isn't on) the generic `ws://host:port`-on-stderr pattern. */
    usesDaemonAssignedPort?: boolean;
    /** Query-string params built from the agent's config at launch time (e.g. a shared-secret token
     *  read from `agent.env`). */
    query?(agent: ExternalAgentView): Record<string, string> | undefined;
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

/** Build a full `ExternalAgentProviderAdapter` for a coding CLI whose app-server launch mode is a
 *  persistent gateway process reached over WebSocket (OpenClaw, Hermes), plus pty/cli-oneshot
 *  fallbacks. */
export function makeAppServerCliAdapter(
  options: MakeAppServerCliAdapterOptions
): Omit<ExternalAgentProviderAdapter, 'events'> {
  const appServerTransports = ['ws'] as const;

  function skipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
    if (!skipProviderApprovals || !options.skipApprovalFlag || hasFlag(args, options.skipApprovalFlag)) return args;
    return [...args, options.skipApprovalFlag];
  }

  function buildLaunch(agent: ExternalAgentView, opts: BuildExternalAgentLaunchOptions): ExternalAgentLaunchSpec {
    const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
    let args = [...(agent.args ?? [])];
    if (opts.providerSessionRef && !hasFlag(args, '--session-id')) {
      args.push('--session-id', opts.providerSessionRef);
    }
    const modelId = opts.modelId ?? opts.modelName;
    if (modelId && !hasFlag(args, '--model')) args.push('--model', modelId);
    args = skipApprovalArgs(args, !!opts.skipProviderApprovals);

    if (launchMode === 'app-server') {
      if (!options.appServerSubcommand) {
        throw new ExternalAgentError('unsupported_capability', `${options.label} has no app-server backend`);
      }
      const transport = opts.appServerTransport ?? agent.appServerTransport ?? 'ws';
      if (!(appServerTransports as readonly string[]).includes(transport)) {
        throw new ExternalAgentError(
          'unsupported_capability',
          `${options.label} app-server transport "${transport}" is not supported; use ${appServerTransports.join(' or ')}`
        );
      }
      const usesDaemonPort = options.appServerWs?.usesDaemonAssignedPort && opts.appServerPort !== undefined;
      const portArgs = usesDaemonPort ? [options.appServerWs?.portFlag ?? '--port', String(opts.appServerPort)] : [];
      return {
        argv: [agent.command, ...(options.appServerSubcommand ?? []), ...portArgs, ...args],
        cwd: opts.workingPath,
        env: agent.env,
        launchMode,
        appServerTransport: transport,
        appServerWs: options.appServerWs
          ? compactObject({
              path: options.appServerWs.path,
              query: options.appServerWs.query?.(agent),
              port: usesDaemonPort ? opts.appServerPort : undefined
            })
          : undefined,
        provider: options.provider,
        approvalOwnership: 'provider-owned',
        capabilities: ['app-server', 'provider-approval', 'approval-resolution', 'session-resume']
      };
    }

    if (launchMode === 'cli-oneshot') {
      if (!options.oneshot) {
        throw new ExternalAgentError('unsupported_capability', `${options.label} has no cli-oneshot launch mode`);
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
      capabilities: options.appServerSubcommand
        ? ['pty', 'app-server', 'provider-approval', 'session-resume']
        : ['pty', 'provider-approval']
    };
  }

  function buildAuthLaunch(agent: ExternalAgentView, args: string[]): ExternalAgentLaunchSpec {
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

  function parseTerminalOutput(chunk: string): ExternalAgentOutputEvent[] {
    return chunk.length > 0 ? [{ type: 'agent_message', payload: { text: chunk } }] : [];
  }

  const adapter: Omit<ExternalAgentProviderAdapter, 'events'> = {
    provider: options.provider,
    productIcon: options.productIcon,
    label: options.label,
    settings: () =>
      externalAgentAdapterSettings({
        launchModes: [
          'pty',
          ...(options.appServerSubcommand ? (['app-server'] as const) : []),
          ...(options.oneshot ? (['cli-oneshot'] as const) : [])
        ],
        ...(options.appServerSubcommand ? { appServerTransports: [...appServerTransports] } : {})
      }),
    ...(options.managedRuntime ? { managedRuntime: options.managedRuntime } : {}),
    ...(options.oneshot ? { oneshotTurnArgs: options.oneshot.turnArgs } : {}),
    ...(options.appServerWs?.usesDaemonAssignedPort ? { usesDaemonAssignedAppServerPort: true } : {}),
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
        defaultLaunchMode: 'pty',
        supportedLaunchModes: [
          'pty',
          ...(options.appServerSubcommand ? (['app-server'] as const) : []),
          ...(options.oneshot ? (['cli-oneshot'] as const) : [])
        ],
        ...(options.appServerSubcommand ? { supportedAppServerTransports: [...appServerTransports] } : {}),
        settings: adapter.settings?.(),
        installHint: options.installHint,
        installUrl: options.installUrl,
        installed,
        resolvedBinPath: bin,
        capabilities: {
          auth: 'pty',
          history: 'none',
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
        parse: (output) => parseExternalAgentArgumentSupport(output)
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
      options.appServerHooks?.initialize(handle, context);
    },
    parseOutput(chunk, handle) {
      if (handle?.launchMode !== 'app-server' || !options.appServerHooks) return parseTerminalOutput(chunk);
      return options.appServerHooks.parseAppServerOutput(chunk, handle);
    },
    sendInput(handle, input) {
      if (handle.launchMode === 'app-server' && options.appServerHooks) {
        options.appServerHooks.sendAppServerInput(handle, input);
        return;
      }
      sendPtyInput(handle, input);
    },
    resolveApproval(handle, resolution) {
      if (handle.launchMode !== 'app-server') {
        throw new Error(`${options.label} external agent approval resolution is provider-owned in pty mode`);
      }
      options.appServerHooks?.resolveAppServerApproval(handle, resolution);
    },
    resize(handle, cols, rows) {
      if (handle.launchMode === 'app-server') return;
      resizePty(handle, cols, rows);
    },
    stop(handle) {
      if (handle.launchMode === 'app-server') {
        handle.appServer?.close();
        handle.kill('SIGTERM');
        return;
      }
      stopPty(handle);
    }
  };
  return adapter;
}
