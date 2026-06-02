import type {
  MeshAgentManagedEnvContext,
  MeshAgentProviderAdapter,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseStructuredAuthState } from '../adapter-shared.ts';
import { createProjectedEventSource } from '../event-source.ts';
import { makeGatewayAdapter } from '../gateway/adapter.ts';
import { GatewayDriver } from '../gateway/driver.ts';
import { agentAdapterIcons } from '../icons.ts';
import {
  type ManagedMcpConfigRunner,
  mirrorManagedConfigHome,
  requireManagedMcpConfigCommand,
  runManagedMcpConfigCommand
} from '../managed-mcp-config.ts';
import { noopProviderSessionLifecycle } from '../provider-session-lifecycle.ts';
import { createFrameworkSettingsImport } from '../settings-import/index.ts';
import { hermesEventPage, hermesEventPageOutput } from './event-pages.ts';
import { hermesGatewayHooks } from './gateway/index.ts';
import { hermesObservationProjection } from './observation.ts';

const HERMES_SUPPORTED_MODELS: string[] = [];

export function hermesManagedMcpEnv(
  context: MeshAgentManagedEnvContext,
  run: ManagedMcpConfigRunner = runManagedMcpConfigCommand
): Record<string, string> {
  if (!context.agentCommand || !context.mcpServer) throw new Error('Hermes managed runtime requires an MCP server');
  const sourceHome = context.agentEnv?.HERMES_HOME ?? join(homedir(), '.hermes');
  const managedHome = join(context.workspace, '.hermes-managed');
  mirrorManagedConfigHome(sourceHome, managedHome, 'config.yaml', '{}\n');
  const env: Record<string, string> = { ...(context.agentEnv ?? {}), HERMES_HOME: managedHome };
  requireManagedMcpConfigCommand(
    'Hermes',
    {
      argv: [
        context.agentCommand,
        'mcp',
        'add',
        context.mcpServer.name,
        '--command',
        context.mcpServer.command,
        '--env',
        ...Object.entries(context.mcpServer.env).map(([key, value]) => `${key}=${value}`),
        '--args',
        ...context.mcpServer.args
      ],
      cwd: context.workspace,
      env
    },
    run
  );
  return { HERMES_HOME: managedHome };
}

const baseHermesMeshAgentAdapter = makeGatewayAdapter({
  provider: 'hermes',
  icon: agentAdapterIcons.hermes,
  productIcon: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  gatewaySubcommand: ['serve', '--isolated', '--skip-build'],
  // Confirmed against the official CLI reference: `--yolo` bypasses dangerous-command approval prompts.
  skipApprovalFlag: '--yolo',
  models: HERMES_SUPPORTED_MODELS,
  installHint: 'Install Hermes, then sign in with hermes auth.',
  installUrl: 'https://hermes-agent.nousresearch.com',
  authStatusArgs: ['list'],
  // `hermes auth list` rejects `--json`, so probe plain-text (exit 0 = authenticated) — else a signed-in
  // Hermes would be misreported as unauthenticated and its managed members would falsely require reconnect.
  authStatusJson: false,
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    const normalized = output.trim().toLowerCase();
    if (/no accounts|no credentials|not signed in|not authenticated/.test(normalized)) return 'unauthenticated';
    if (exitCode !== 0) return exitCode === null ? 'unknown' : 'unauthenticated';
    if (!normalized) return 'unknown';
    return 'authenticated';
  }
});

function createHermesSessionRuntime(
  agent: Parameters<NonNullable<MeshAgentProviderAdapter['createSessionRuntime']>>[0],
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  const dashboardToken =
    context.env?.HERMES_DASHBOARD_SESSION_TOKEN ??
    agent.env?.HERMES_DASHBOARD_SESSION_TOKEN ??
    crypto.randomUUID().replaceAll('-', '');
  const runtimeEnv = {
    ...(agent.env ?? {}),
    ...(context.env ?? {}),
    HERMES_DASHBOARD_SESSION_TOKEN: dashboardToken
  };
  const runtimeAgent = { ...agent, env: runtimeEnv };
  const launch = baseHermesMeshAgentAdapter.buildGatewayLaunch(runtimeAgent, {
    workingPath: context.workingPath,
    skipProviderApprovals: context.skipProviderApprovals
  });
  return {
    plan: {
      processModel: 'resident',
      launch: {
        args: launch.argv.slice(1),
        cwd: launch.cwd,
        env: runtimeEnv
      },
      channel: {
        kind: 'websocket',
        endpoint: 'daemon-loopback',
        path: '/api/ws',
        query: { token: dashboardToken },
        portArgument: '--port'
      },
      startup: { timeoutMs: 30_000 },
      reconnect: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 }
    },
    driver: new GatewayDriver({
      hooks: hermesGatewayHooks,
      providerSessionRef: context.providerSessionRef,
      initialize: {
        workingPath: context.workingPath,
        env: runtimeEnv,
        adapterSettings: agent.adapterSettings
      }
    })
  };
}

export const hermesMeshAgentAdapter: MeshAgentProviderAdapter = {
  ...baseHermesMeshAgentAdapter,
  discoverAgents(agent) {
    const root = agent.env?.HERMES_HOME ?? join(homedir(), '.hermes');
    return {
      launch: {
        argv: [agent.command, 'profile', 'list'],
        cwd: homedir(),
        env: agent.env
      },
      parse(output, exitCode) {
        if (exitCode !== 0) return [];
        const names = output
          .split(/\r?\n/)
          .map((line) => line.trim().replace(/^◆/, '').split(/\s+/)[0])
          .filter(
            (name): name is string => !!name && name !== 'Profile' && !/^[-─]+$/.test(name) && !name.endsWith(':')
          );
        return [...new Set(names)].map((name) => ({
          externalId: name,
          displayName: name,
          env: { ...(agent.env ?? {}), HERMES_HOME: name === 'default' ? root : join(root, 'profiles', name) }
        }));
      }
    };
  },
  unsafeArgument: (args) => args.find((arg) => arg === '--yolo'),
  events: createProjectedEventSource({
    provider: 'hermes',
    projection: hermesObservationProjection,
    readPage: async (context, request) => {
      const page = await hermesEventPage({
        ...context,
        request: {
          before: request.before,
          limit: request.limit,
          sortDirection: 'desc',
          itemsView: 'full'
        }
      });
      if (!page) return { state: 'unavailable', reason: 'not-found' };
      if (request.view === 'raw') {
        return {
          state: 'available',
          view: 'raw',
          records: [...page.items].reverse().map((data, index) => ({
            data,
            cursor: `${request.before ?? ''}:${index}`
          })),
          coverage: 'exact',
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        };
      }
      const output = hermesEventPageOutput({ ...context, page });
      if (!output) return { state: 'unavailable', reason: 'not-found' };
      const source = createProjectedEventSource({ provider: 'hermes', projection: hermesObservationProjection });
      return {
        state: 'available',
        view: 'convenience',
        events: source.projectLive({ id: context.providerSessionRef, output, mode: 'events' }).events,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      };
    }
  }),
  observation: hermesObservationProjection,
  settingsImport: createFrameworkSettingsImport('hermes', 'Hermes'),
  managedRuntime: {
    env: hermesManagedMcpEnv,
    usesManagedMcpBridge: true
  },
  createSessionRuntime: createHermesSessionRuntime,
  unarchiveSession: noopProviderSessionLifecycle,
  detect(probes) {
    const preset = baseHermesMeshAgentAdapter.detect(probes);
    return {
      ...preset,
      capabilities: {
        auth: preset.capabilities?.auth ?? 'pty',
        events: 'provider-owned',
        resume: preset.capabilities?.resume ?? 'pty',
        approval: preset.capabilities?.approval ?? 'provider-owned',
        approvalProxy: true,
        settingsImport: true
      }
    };
  }
};
