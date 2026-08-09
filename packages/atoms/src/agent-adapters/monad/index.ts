import type {
  MeshAgentProviderAdapter,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';

import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';
import { z } from 'zod';

import { agentAdapterIcons } from '../icons.ts';
import { noopProviderSessionLifecycle } from '../provider-session-lifecycle.ts';
import { MonadSessionEventDriver } from './driver.ts';
import { createMonadEventSource } from './event-pages.ts';
import { monadObservationProjection } from './observation.ts';

const discoveredAgentsSchema = z.object({
  agents: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
});

function createMonadSessionRuntime(
  agent: Parameters<NonNullable<MeshAgentProviderAdapter['createSessionRuntime']>>[0],
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  const agentId = agent.adapterSettings?.agentId;
  if (typeof agentId !== 'string' || !agentId) throw new Error('Monad MeshAgent requires adapterSettings.agentId');
  return {
    plan: {
      processModel: 'resident',
      launch: {
        args: [...(agent.args ?? []), 'app-server'],
        cwd: context.workingPath,
        ...(context.env || agent.env ? { env: { ...(agent.env ?? {}), ...(context.env ?? {}) } } : {})
      },
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 }
    },
    driver: new MonadSessionEventDriver(
      agentId,
      context.workingPath,
      context.providerSessionRef,
      context.managedMcpServer,
      context.startInput?.immutableInstructions?.text
    )
  };
}

export const monadMeshAgentAdapter: MeshAgentProviderAdapter = {
  provider: 'monad',
  icon: agentAdapterIcons.monad,
  productIcon: 'monad',
  label: 'Monad',
  executionCapabilities: { autopilot: true, fastMode: false },
  observation: monadObservationProjection,
  managedRuntime: {
    usesManagedMcpBridge: true
  },
  events: createMonadEventSource(),
  detect(probes = defaultBinProbes) {
    const resolvedBinPath = resolveBinary('monad', [], probes);
    return {
      id: 'monad',
      label: 'Monad',
      provider: 'monad',
      productIcon: 'monad',
      command: 'monad',
      args: [],
      installHint: 'Install Monad and start its local daemon.',
      installUrl: 'https://monad.co',
      installed: resolvedBinPath !== undefined,
      ...(resolvedBinPath ? { resolvedBinPath } : {}),
      capabilities: {
        auth: 'none',
        events: 'provider-owned',
        resume: 'structured',
        approval: 'provider-owned',
        approvalProxy: true
      }
    };
  },
  resolveCommand(command, probes = defaultBinProbes) {
    return resolveBinary(command, [], probes);
  },
  listSupportedModels() {
    return [];
  },
  buildAuthLaunch(agent) {
    return { argv: [agent.command, ...(agent.args ?? []), '--version'], cwd: process.cwd(), env: agent.env };
  },
  buildAuthStatusLaunch(agent) {
    return { argv: [agent.command, ...(agent.args ?? []), '--version'], cwd: process.cwd(), env: agent.env };
  },
  authStatus(agent) {
    return { launch: monadMeshAgentAdapter.buildAuthStatusLaunch(agent), parse: () => 'authenticated' };
  },
  parseAuthStatus() {
    return 'authenticated';
  },
  discoverAgents(agent) {
    return {
      launch: {
        argv: [agent.command, ...(agent.args ?? []), 'app-server', '--list-agents'],
        cwd: process.cwd(),
        ...(agent.env ? { env: agent.env } : {})
      },
      parse(output, exitCode) {
        if (exitCode !== 0) return [];
        try {
          const parsed = discoveredAgentsSchema.parse(JSON.parse(output));
          return parsed.agents.map((item) => ({
            externalId: item.id,
            displayName: item.name,
            adapterSettings: { agentId: item.id }
          }));
        } catch {
          return [];
        }
      }
    };
  },
  createSessionRuntime: createMonadSessionRuntime,
  unarchiveSession: noopProviderSessionLifecycle
};
