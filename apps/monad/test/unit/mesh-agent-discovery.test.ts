import type { MeshAgentConfig, MonadConfig } from '@monad/environment';
import type { MeshAgentDiscoveredAgent } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import {
  discoveredMeshAgentName,
  readBoundedDiscoveryStream,
  syncDiscoveredMeshAgents
} from '../../src/services/mesh-agent/discovery.ts';

function config(meshAgents: MeshAgentConfig[]): MonadConfig {
  return { meshAgents } as MonadConfig;
}

const openclaw: MeshAgentConfig = {
  name: 'openclaw',
  provider: 'openclaw',
  command: 'openclaw',
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
};

const hermes: MeshAgentConfig = {
  name: 'hermes',
  provider: 'hermes',
  command: 'hermes',
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
};

test('discovery stops reading as soon as provider output exceeds the byte limit', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(5));
      controller.enqueue(new Uint8Array(100));
    }
  });

  await expect(readBoundedDiscoveryStream(stream, 10)).rejects.toThrow('exceeded the output limit');
  expect(cancelled).toBe(true);
});

test('discovery inserts same-name provider agents with distinct internal names and raw display names', async () => {
  const discovered: Record<string, MeshAgentDiscoveredAgent[]> = {
    openclaw: [{ externalId: 'test', displayName: 'test', adapterSettings: { agentId: 'test' } }],
    hermes: [{ externalId: 'test', displayName: 'test', env: { HERMES_HOME: '/tmp/hermes/profiles/test' } }]
  };
  const result = await syncDiscoveredMeshAgents(config([openclaw, hermes]), {
    discover: async (connector) => discovered[connector.name] ?? []
  });

  expect(discoveredMeshAgentName('openclaw', 'test')).toBe('openclaw--test');
  expect(result.changed).toBe(true);
  expect(result.cfg.meshAgents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'openclaw--test',
        displayName: 'test',
        provider: 'openclaw',
        discovery: { connectorName: 'openclaw', externalId: 'test', state: 'available' }
      }),
      expect.objectContaining({
        name: 'hermes--test',
        displayName: 'test',
        provider: 'hermes',
        env: { HERMES_HOME: '/tmp/hermes/profiles/test' }
      })
    ])
  );
});

test('discovery starts independent provider connectors concurrently and reconciles in connector order', async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const pending = syncDiscoveredMeshAgents(config([openclaw, hermes]), {
    discover: async (connector) => {
      started.push(connector.name);
      await new Promise<void>((resolve) => releases.set(connector.name, resolve));
      return [{ externalId: `${connector.name}-agent`, displayName: connector.name }];
    }
  });

  await Bun.sleep(0);
  expect(started).toEqual(['openclaw', 'hermes']);
  releases.get('hermes')?.();
  releases.get('openclaw')?.();

  expect((await pending).cfg.meshAgents.map((agent) => agent.name)).toEqual([
    'openclaw',
    'hermes',
    'openclaw--openclaw-agent',
    'hermes--hermes-agent'
  ]);
});

test('discovery is idempotent, preserves user fields, and disables stale rows', async () => {
  const first = await syncDiscoveredMeshAgents(config([openclaw]), {
    discover: async () => [{ externalId: 'test', displayName: 'test', adapterSettings: { agentId: 'test' } }]
  });
  const discovered = first.cfg.meshAgents.find((agent) => agent.discovery);
  if (!discovered) throw new Error('expected discovered row');
  discovered.env = { MONAD_PROFILE: 'reviewer' };
  const second = await syncDiscoveredMeshAgents(first.cfg, {
    discover: async () => [{ externalId: 'test', displayName: 'test', adapterSettings: { agentId: 'test' } }]
  });
  expect(second.changed).toBe(false);
  expect(second.cfg.meshAgents.find((agent) => agent.discovery)?.env).toEqual({ MONAD_PROFILE: 'reviewer' });

  const stale = await syncDiscoveredMeshAgents(second.cfg, { discover: async () => [] });
  expect(stale.cfg.meshAgents.find((agent) => agent.discovery)).toMatchObject({
    enabled: false,
    discovery: { state: 'missing' }
  });
});

test('discovery does not overwrite a manual internal-name collision and fails soft', async () => {
  const manual: MeshAgentConfig = { ...openclaw, name: 'openclaw--test' };
  const inserted = await syncDiscoveredMeshAgents(config([openclaw, manual]), {
    discover: async () => [{ externalId: 'test', displayName: 'test' }]
  });
  expect(inserted.cfg.meshAgents.find((agent) => agent.discovery)?.name).toBe('openclaw--test--discovered');
  expect(inserted.cfg.meshAgents.find((agent) => agent.name === manual.name)?.discovery).toBeUndefined();

  const warnings: string[] = [];
  const failed = await syncDiscoveredMeshAgents(inserted.cfg, {
    discover: async () => {
      throw new Error('provider offline');
    },
    onWarning: (message) => warnings.push(message)
  });
  expect(failed.changed).toBe(false);
  expect(failed.cfg.meshAgents.find((agent) => agent.discovery)?.enabled).toBe(true);
  expect(warnings).toEqual([expect.stringContaining('provider offline')]);
});
