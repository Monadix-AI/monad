import type {
  ChannelIcon,
  MeshAgentAuthState,
  MeshAgentProductIcon,
  MeshAgentProvider,
  MeshAgentView
} from '@monad/protocol';
import type { MeshAgentLaunchSpec, MeshAgentProviderAdapter } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { hasFlag, parseStructuredAuthState } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { meshAgentAdapterSettings } from '../settings.ts';

interface MakeGatewayAdapterOptions {
  provider: MeshAgentProvider;
  icon: ChannelIcon;
  productIcon: MeshAgentProductIcon;
  label: string;
  bin: string;
  gatewaySubcommand: string[];
  models: string[];
  installHint: string;
  installUrl: string;
  authLaunchArgs?: string[];
  authStatusArgs: string[];
  authStatusLaunchArgs?: string[];
  authStatusJson?: boolean;
  parseAuthStatus?(output: string, exitCode: number | null): MeshAgentAuthState;
  skipApprovalFlag?: string;
}

type GatewayAdapter = Omit<MeshAgentProviderAdapter, 'events'> & {
  buildGatewayLaunch(
    agent: MeshAgentView,
    options: { workingPath: string; skipProviderApprovals?: boolean }
  ): MeshAgentLaunchSpec;
};

export function makeGatewayAdapter(options: MakeGatewayAdapterOptions): GatewayAdapter {
  function buildGatewayLaunch(
    agent: MeshAgentView,
    launchOptions: { workingPath: string; skipProviderApprovals?: boolean }
  ): MeshAgentLaunchSpec {
    const args = [...(agent.args ?? [])];
    if (launchOptions.skipProviderApprovals && options.skipApprovalFlag && !hasFlag(args, options.skipApprovalFlag)) {
      args.push(options.skipApprovalFlag);
    }
    return {
      argv: [agent.command, ...args, ...options.gatewaySubcommand],
      cwd: launchOptions.workingPath,
      env: agent.env
    };
  }

  function buildAuthLaunch(agent: MeshAgentView, args: string[]): MeshAgentLaunchSpec {
    return {
      argv: [agent.command, ...args],
      cwd: homedir(),
      env: agent.env
    };
  }

  const adapter: GatewayAdapter = {
    provider: options.provider,
    icon: options.icon,
    productIcon: options.productIcon,
    label: options.label,
    executionCapabilities: { autopilot: options.skipApprovalFlag !== undefined, fastMode: false },
    settings: () => meshAgentAdapterSettings(),
    detect(probes = defaultBinProbes) {
      const bin = resolveBinary(options.bin, [], probes);
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
        installed: bin !== undefined,
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
    buildGatewayLaunch,
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
    }
  };
  return adapter;
}
