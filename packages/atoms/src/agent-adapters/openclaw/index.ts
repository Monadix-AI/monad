import type {
  MeshAgentManagedEnvContext,
  MeshAgentProviderAdapter,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createProjectedEventSource } from '../event-source.ts';
import { makeGatewayAdapter } from '../gateway/adapter.ts';
import { GatewayDriver } from '../gateway/driver.ts';
import { agentAdapterIcons } from '../icons.ts';
import {
  copyManagedConfigFile,
  type ManagedMcpConfigRunner,
  requireManagedMcpConfigCommand,
  runManagedMcpConfigCommand
} from '../managed-mcp-config.ts';
import { noopProviderSessionLifecycle } from '../provider-session-lifecycle.ts';
import { createFrameworkSettingsImport } from '../settings-import/index.ts';
import { openClawHistoryRecords } from './event-pages.ts';
import { openClawGatewayHooks } from './gateway/index.ts';
import { openClawObservationProjection } from './observation.ts';

// OpenClaw ships no models-list command; these are the models its docs advertise for `--model`.
// Kept as a small fallback list (an operator can override via the agent's modelOptions).
const OPENCLAW_SUPPORTED_MODELS = ['openclaw-default'];

export function openClawManagedMcpEnv(
  context: MeshAgentManagedEnvContext,
  run: ManagedMcpConfigRunner = runManagedMcpConfigCommand
): Record<string, string> {
  if (!context.agentCommand || !context.mcpServer) throw new Error('OpenClaw managed runtime requires an MCP server');
  const stateDir = context.agentEnv?.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw');
  const sourceConfig = context.agentEnv?.OPENCLAW_CONFIG_PATH ?? join(stateDir, 'openclaw.json');
  const managedConfig = join(context.workspace, '.openclaw-managed.json');
  copyManagedConfigFile(sourceConfig, managedConfig, '{}\n');
  writeFileSync(join(context.workspace, 'AGENTS.md'), context.immutableInstructions.text, { mode: 0o600 });
  const env: Record<string, string> = {
    ...(context.agentEnv ?? {}),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: managedConfig
  };
  requireManagedMcpConfigCommand(
    'OpenClaw',
    {
      argv: [
        context.agentCommand,
        'mcp',
        'set',
        context.mcpServer.name,
        JSON.stringify({
          command: context.mcpServer.command,
          args: context.mcpServer.args,
          env: context.mcpServer.env
        })
      ],
      cwd: context.workspace,
      env
    },
    run
  );
  return { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: managedConfig };
}

// OpenClaw has NO CLI flag or env var that bypasses exec approvals (previously this adapter appended
// a nonexistent `--auto-approve` — removed via the shared factory's `skipApprovalFlag` opt-in, which
// OpenClaw deliberately omits). Its docs (docs.openclaw.ai/tools/exec-approvals) say the only way is
// its own config (`tools.exec.security`/`ask`) plus a host-local approvals file
// (`defaults.askFallback` — docs.openclaw.ai/gateway/configuration), and `OPENCLAW_HOME`/
// `OPENCLAW_STATE_DIR` are the documented per-instance overrides for where those live.
//
// This is DELIBERATELY not wired up: OpenClaw's own credential store — `auth-profiles.json` under
// `~/.openclaw/agents/<agentId>/agent/` — "also respects `$OPENCLAW_STATE_DIR`" per its auth docs, so
// redirecting either var to give this agent a private exec-approvals override would silently strand
// the managed session with NO stored auth (it would look for auth-profiles.json in the fresh,
// credential-less directory instead of the operator's real one). A correct fix needs either a
// verified credential-preserving injection (e.g. seeding just the relevant auth-profiles.json into the
// override dir) or hands-on verification against the real binary — not something to guess from docs
// alone given the blast radius (silently broken auth) of getting it wrong.
//
// Net effect: OpenClaw managed agents do NOT currently support autopilot — `allowAutopilot: true` no
// longer sends a broken flag (previously could error/no-op unpredictably), but OpenClaw still prompts
// for approvals it has no channel to resolve while unmanaged. Delegated mode (`allowAutopilot: false`)
// is unaffected and works today via the real `approval.request`/`approval.respond` gateway channel
// (see ./gateway) — this gap is specifically the *autopilot* path. No `managedRuntime.env` hook is
// wired below for this reason — leaving it unset is the correct, safe state until that's resolved.

// Real gateway backend (verified live, see openclaw/gateway) — uses provider-owned hooks
// rather than `protocol` because OpenClaw's wire envelope isn't generic JSON-RPC.
const baseOpenClawMeshAgentAdapter = makeGatewayAdapter({
  provider: 'openclaw',
  icon: agentAdapterIcons.openclaw,
  productIcon: 'openclaw',
  label: 'OpenClaw',
  bin: 'openclaw',
  // `openclaw gateway` alone only prints the subcommand's usage and exits — the real foreground-run
  // command is `gateway run`. `--allow-unconfigured` lets it start without a prior `openclaw onboard`
  // (verified against `openclaw gateway --help`; the daemon otherwise refuses to start a fresh config).
  gatewaySubcommand: ['gateway', 'run', '--allow-unconfigured'],
  models: OPENCLAW_SUPPORTED_MODELS,
  installHint: 'Install OpenClaw, then sign in with openclaw models auth login.',
  installUrl: 'https://docs.openclaw.ai',
  authLaunchArgs: ['models', 'auth', 'login'],
  authStatusArgs: ['status'],
  authStatusLaunchArgs: ['models', 'status', '--check'],
  parseAuthStatus(output, exitCode) {
    const normalized = output.toLowerCase();
    if (exitCode === 0 || exitCode === 2) return 'authenticated';
    if (exitCode === 1) return 'unauthenticated';
    if (/missing auth|not authenticated|not signed in|no auth/.test(normalized)) return 'unauthenticated';
    if (/auth|credential|profile/.test(normalized)) return 'authenticated';
    return 'unknown';
  }
});

function createOpenClawSessionRuntime(
  agent: Parameters<NonNullable<MeshAgentProviderAdapter['createSessionRuntime']>>[0],
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  const gatewayToken =
    context.env?.OPENCLAW_GATEWAY_TOKEN ?? agent.env?.OPENCLAW_GATEWAY_TOKEN ?? crypto.randomUUID().replaceAll('-', '');
  const runtimeEnv = {
    ...(agent.env ?? {}),
    ...(context.env ?? {}),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken
  };
  const runtimeAgent = { ...agent, env: runtimeEnv };
  const launch = baseOpenClawMeshAgentAdapter.buildGatewayLaunch(runtimeAgent, {
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
        portArgument: '--port',
        connectDelayMs: 500
      },
      startup: { timeoutMs: 30_000 },
      reconnect: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 }
    },
    driver: new GatewayDriver({
      hooks: openClawGatewayHooks,
      providerSessionRef: context.providerSessionRef,
      initialize: {
        workingPath: context.workingPath,
        ...(context.startInput?.immutableInstructions
          ? { systemPromptWorkspace: context.env?.MONAD_RUNTIME_WORKSPACE }
          : {}),
        env: runtimeEnv,
        adapterSettings: agent.adapterSettings
      }
    })
  };
}

export const openClawMeshAgentAdapter: MeshAgentProviderAdapter = {
  ...baseOpenClawMeshAgentAdapter,
  discoverAgents(agent) {
    return {
      launch: {
        argv: [agent.command, 'agents', 'list', '--json'],
        cwd: homedir(),
        env: agent.env
      },
      parse(output, exitCode) {
        if (exitCode !== 0) return [];
        let value: unknown;
        try {
          value = JSON.parse(output);
        } catch {
          return [];
        }
        if (!Array.isArray(value)) return [];
        return value.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const { id, name } = entry as { id?: unknown; name?: unknown };
          if (typeof id !== 'string' || id.length === 0) return [];
          return [
            {
              externalId: id,
              displayName: typeof name === 'string' && name.length > 0 ? name : id,
              adapterSettings: { agentId: id }
            }
          ];
        });
      }
    };
  },
  observation: openClawObservationProjection,
  events: createProjectedEventSource({
    provider: 'openclaw',
    projection: openClawObservationProjection,
    readPage: async (context, request) => {
      const records = await openClawHistoryRecords(context);
      if (!records) return { state: 'unavailable', reason: 'not-found' };
      const before = /^line:(\d+)$/.exec(request.before ?? '')?.[1];
      const parsedEnd = before ? Number.parseInt(before, 10) : records.length;
      const end = Number.isSafeInteger(parsedEnd) ? Math.min(records.length, Math.max(0, parsedEnd)) : records.length;
      const start = Math.max(0, end - request.limit);
      const page = records.slice(start, end);
      const nextCursor = start > 0 ? `line:${start}` : undefined;
      if (request.view === 'raw') {
        return {
          state: 'available',
          view: 'raw',
          records: page.map((data, index) => ({
            data,
            cursor: `line:${start + index}`,
            ...(typeof data.id === 'string' ? { providerIdentity: data.id } : {})
          })),
          coverage: 'settled',
          ...(nextCursor ? { nextCursor } : {})
        };
      }
      const source = createProjectedEventSource({
        provider: 'openclaw',
        projection: openClawObservationProjection
      });
      return {
        state: 'available',
        view: 'convenience',
        events: source.projectLive({
          id: context.providerSessionRef,
          providerSessionRef: context.providerSessionRef,
          output: page.map((record) => JSON.stringify(record)).join('\n'),
          mode: 'events'
        }).events,
        ...(nextCursor ? { nextCursor } : {})
      };
    }
  }),
  settingsImport: createFrameworkSettingsImport('openclaw', 'OpenClaw'),
  managedRuntime: {
    env: openClawManagedMcpEnv,
    usesManagedMcpBridge: true
  },
  createSessionRuntime: createOpenClawSessionRuntime,
  unarchiveSession: noopProviderSessionLifecycle,
  // OpenClaw's gateway projects and resolves provider approvals, so managed sessions can delegate
  // approval decisions to the human.
  detect(probes) {
    const preset = baseOpenClawMeshAgentAdapter.detect(probes);
    return {
      ...preset,
      capabilities: {
        auth: preset.capabilities?.auth ?? 'pty',
        events: 'provider-owned',
        resume: preset.capabilities?.resume ?? 'pty',
        approval: preset.capabilities?.approval ?? 'provider-owned',
        approvalProxy: true,
        settingsImport: true,
        agentInstances: 'hosted'
      }
    };
  }
};
