import type { MeshAgentConfig, MonadConfig } from '@monad/environment';
import type { MeshAgentDiscoveredAgent, MeshAgentProviderAdapter } from '@monad/sdk-atom';

import { createLogger } from '@monad/logger';
import { meshAgentNameSchema } from '@monad/protocol';

import { getMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';

const log = createLogger('mesh-agent');
const DISCOVERY_TIMEOUT_MS = 2_000;
const DISCOVERY_MAX_BUFFER_BYTES = 1024 * 1024;

export async function readBoundedDiscoveryStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error('exceeded the output limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export interface MeshAgentDiscoverySyncOptions {
  discover?: (connector: MeshAgentConfig) => Promise<MeshAgentDiscoveredAgent[]>;
  onWarning?: (message: string) => void;
}

function connectorView(connector: MeshAgentConfig, adapter: MeshAgentProviderAdapter) {
  return {
    ...connector,
    productIcon: adapter.productIcon,
    approvalOwnership: 'provider-owned' as const
  };
}

async function discoverWithAdapter(connector: MeshAgentConfig): Promise<MeshAgentDiscoveredAgent[]> {
  const adapter = getMeshAgentProviderAdapter(connector.provider);
  const probe = adapter.discoverAgents?.(connectorView(connector, adapter));
  if (!probe) return [];
  const command = probe.launch.argv[0];
  if (!command) throw new Error(`MeshAgent discovery for ${connector.name} has no command`);
  const child = Bun.spawn([command, ...probe.launch.argv.slice(1)], {
    cwd: probe.launch.cwd,
    env: { ...process.env, ...(probe.launch.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, DISCOVERY_TIMEOUT_MS);
  try {
    const [stdout, _stderr, exitCode] = await Promise.all([
      readBoundedDiscoveryStream(child.stdout, DISCOVERY_MAX_BUFFER_BYTES),
      readBoundedDiscoveryStream(child.stderr, DISCOVERY_MAX_BUFFER_BYTES),
      child.exited
    ]);
    if (timedOut) throw new Error(`MeshAgent discovery for ${connector.name} timed out`);
    if (exitCode !== 0) {
      throw new Error(`MeshAgent discovery for ${connector.name} exited with code ${String(exitCode)}`);
    }
    return probe.parse(new TextDecoder().decode(stdout), exitCode);
  } catch (error) {
    child.kill();
    await child.exited;
    if (error instanceof Error && error.message === 'exceeded the output limit') {
      throw new Error(`MeshAgent discovery for ${connector.name} exceeded the output limit`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function discoveredMeshAgentName(provider: string, externalId: string): string {
  return `${provider}--${externalId}`.replaceAll(/[\\/:\0]/g, '-');
}

function discoveredName(
  agents: readonly MeshAgentConfig[],
  connector: MeshAgentConfig,
  item: MeshAgentDiscoveredAgent
): string {
  const base = discoveredMeshAgentName(connector.provider, item.externalId);
  const collision = agents.find((agent) => agent.name === base);
  if (!collision || collision.discovery?.connectorName === connector.name) return base;
  return `${base}--discovered`;
}

function reconcileConnector(
  agents: MeshAgentConfig[],
  connector: MeshAgentConfig,
  discovered: readonly MeshAgentDiscoveredAgent[]
): void {
  const valid = discovered.filter(
    (item) =>
      meshAgentNameSchema.safeParse(item.externalId).success &&
      typeof item.displayName === 'string' &&
      item.displayName.length > 0
  );
  const seen = new Set(valid.map((item) => item.externalId));

  for (const item of valid) {
    const existingIndex = agents.findIndex(
      (agent) => agent.discovery?.connectorName === connector.name && agent.discovery.externalId === item.externalId
    );
    const existing = existingIndex >= 0 ? agents[existingIndex] : undefined;
    const next: MeshAgentConfig = {
      ...(existing ?? {}),
      name: existing?.name ?? discoveredName(agents, connector, item),
      displayName: item.displayName,
      provider: connector.provider,
      command: connector.command,
      args: connector.args,
      env: { ...(connector.env ?? {}), ...(existing?.env ?? {}), ...(item.env ?? {}) },
      enabled: true,
      allowAutopilot: existing?.allowAutopilot ?? connector.allowAutopilot,
      approvalOwnership: 'provider-owned',
      adapterSettings: {
        ...(connector.adapterSettings ?? {}),
        ...(existing?.adapterSettings ?? {}),
        ...(item.adapterSettings ?? {})
      },
      discovery: {
        connectorName: connector.name,
        externalId: item.externalId,
        state: 'available'
      }
    };
    if (existingIndex >= 0) agents[existingIndex] = next;
    else agents.push(next);
  }

  for (const [index, agent] of agents.entries()) {
    if (agent.discovery?.connectorName !== connector.name || seen.has(agent.discovery.externalId)) continue;
    agents[index] = {
      ...agent,
      enabled: false,
      discovery: { ...agent.discovery, state: 'missing' }
    };
  }
}

export async function syncDiscoveredMeshAgents(
  cfg: MonadConfig,
  options: MeshAgentDiscoverySyncOptions = {}
): Promise<{ cfg: MonadConfig; changed: boolean }> {
  const before = JSON.stringify(cfg.meshAgents);
  const next = structuredClone(cfg);
  const eligibleConnectors = next.meshAgents.filter((agent) => agent.enabled && !agent.discovery);
  const connectors = [...new Set(eligibleConnectors.map((agent) => agent.provider))].flatMap((provider) => {
    const candidates = eligibleConnectors.filter((agent) => agent.provider === provider);
    const preferred = candidates.find((agent) => agent.name === provider) ?? candidates[0];
    return preferred ? [preferred] : [];
  });
  const discover = options.discover ?? discoverWithAdapter;

  const results = await Promise.all(
    connectors.map(async (connector) => {
      try {
        return { connector, discovered: await discover(connector) } as const;
      } catch (error) {
        return { connector, error } as const;
      }
    })
  );
  for (const result of results) {
    if ('error' in result) {
      const { connector, error } = result;
      const message = `MeshAgent discovery failed for ${connector.name}: ${error instanceof Error ? error.message : String(error)}`;
      if (options.onWarning) options.onWarning(message);
      else log.warn({ connector: connector.name, err: error }, message);
      continue;
    }
    reconcileConnector(next.meshAgents, result.connector, result.discovered);
  }

  return { cfg: next, changed: JSON.stringify(next.meshAgents) !== before };
}
