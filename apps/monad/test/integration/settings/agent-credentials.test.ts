import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { SandboxLauncher } from '@monad/sandbox';
import type { ConfigAccess, ConfigSnapshot } from '#/config/manager.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, emptyAuth } from '@monad/environment';
import {
  configureProtectedCredentialResolver,
  configureProtectedExecutionTls,
  configureSandboxLauncher,
  noneLauncher
} from '@monad/sandbox';

import { createAgentModule } from '#/handlers/settings/agent/index.ts';
import { createCredentialModule } from '#/handlers/settings/credential/index.ts';
import { recoverAgentCreateTransactions } from '#/store/home/agent-create-transaction.ts';
import { makeTestPaths, stubConfigAccess } from '../../helpers.ts';

const AGENT_A = 'agt_000000000001' as const;
const AGENT_B = 'agt_000000000002' as const;
const CREDENTIAL_A = 'cred_00000000001';
const CREDENTIAL_B = 'cred_00000000002';
const secretCanary = 'credential-secret-canary';
const roots: string[] = [];

function storedCredential(environmentVariable: string, secret = secretCanary) {
  const now = '2026-07-29T00:00:00.000Z';
  return {
    label: environmentVariable,
    environmentVariable,
    secret,
    allowedHosts: ['example.com'],
    createdAt: now,
    updatedAt: now
  };
}

async function setup(cfg = createDefaultConfig('Test'), auth: MonadAuth = emptyAuth()) {
  const root = await mkdtemp(join(tmpdir(), 'monad-agent-credentials-'));
  roots.push(root);
  const config = stubConfigAccess(cfg, auth);
  return {
    config,
    agents: createAgentModule({ paths: makeTestPaths(root), config }),
    credentials: createCredentialModule(config)
  };
}

afterEach(async () => {
  configureProtectedCredentialResolver(undefined);
  configureProtectedExecutionTls(false);
  configureSandboxLauncher(noneLauncher);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Credential settings', () => {
  test('create, list, and metadata updates preserve stable IDs while returning only redacted views', async () => {
    const { config, credentials } = await setup();

    const created = await credentials.createCredential({
      label: 'GitHub',
      description: 'GitHub API',
      environmentVariable: 'GITHUB_TOKEN',
      secret: secretCanary,
      allowedHosts: [' GitHub.COM ', 'api.github.com']
    });
    const id = created.id;

    expect(created).toEqual({
      id,
      label: 'GitHub',
      description: 'GitHub API',
      environmentVariable: 'GITHUB_TOKEN',
      allowedHosts: ['github.com', 'api.github.com'],
      configured: true,
      authorizedAgentIds: []
    });
    expect(JSON.stringify(created)).not.toContain(secretCanary);

    const metadataOnly = await credentials.updateCredential(id, { label: 'GitHub production' });
    expect(metadataOnly).toEqual({ ...created, label: 'GitHub production' });
    expect(config.get().auth?.credentials[id]?.secret).toBe(secretCanary);

    const replacement = await credentials.updateCredential(id, {
      secret: { action: 'replace', value: 'replacement-canary' }
    });
    expect(replacement).toEqual(metadataOnly);
    expect(config.get().auth?.credentials[id]?.secret).toBe('replacement-canary');

    const removed = await credentials.updateCredential(id, { secret: { action: 'remove' } });
    expect(removed).toEqual({ ...metadataOnly, configured: false });
    expect(config.get().auth?.credentials[id]?.secret).toBeUndefined();
    expect(await credentials.listCredentials()).toEqual({ credentials: [removed] });
    expect(JSON.stringify(await credentials.listCredentials())).not.toMatch(
      /secret|preview|fingerprint|createdAt|updatedAt|sentinel|canary/i
    );
  });

  test('agent create and update reject missing IDs and duplicate environment variables without partial mutation', async () => {
    const cfg = createDefaultConfig('Test');
    cfg.agent.agents = [
      {
        id: AGENT_A,
        name: 'Existing',
        capabilities: [],
        credentialIds: [],
        declaredScopes: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        atoms: { mode: 'inherit', allow: [], deny: [] },
        visibility: { subagentCallable: false, public: false },
        a2a: { enabled: false },
        monadix: { consume: false }
      }
    ];
    const auth = emptyAuth();
    auth.credentials = {
      [CREDENTIAL_A]: storedCredential('SHARED_TOKEN'),
      [CREDENTIAL_B]: storedCredential('SHARED_TOKEN', 'other-secret')
    };
    const { agents, config } = await setup(cfg, auth);

    await expect(
      agents.createAgent({
        name: 'Invalid',
        capabilities: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        credentialIds: ['cred_missing00000']
      })
    ).rejects.toMatchObject({
      kind: 'invalid',
      message: 'agent_credential_not_found',
      code: 'agent_credential_not_found',
      params: { credentialId: 'cred_missing00000' }
    });
    expect(config.get().cfg.agent.agents).toEqual(cfg.agent.agents);

    await expect(
      agents.updateAgent({
        agentId: AGENT_A,
        name: 'Mutated',
        credentialIds: [CREDENTIAL_A, CREDENTIAL_B]
      })
    ).rejects.toMatchObject({
      kind: 'invalid',
      message: 'agent_credential_environment_variable_conflict',
      code: 'agent_credential_environment_variable_conflict',
      params: { environmentVariable: 'SHARED_TOKEN' }
    });
    expect(config.get().cfg.agent.agents).toEqual(cfg.agent.agents);
  });

  test('concurrent credential deletion rejects agent create without leaving prompt files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monad-agent-credentials-'));
    roots.push(root);
    const paths = makeTestPaths(root);
    const cfg = createDefaultConfig('Test');
    const auth = emptyAuth();
    auth.credentials[CREDENTIAL_A] = storedCredential('TOKEN');
    const initial: ConfigSnapshot = { cfg, auth };
    const config = {
      get: () => initial,
      status: () => ({ state: 'ready' as const }),
      subscribe: () => () => {},
      update: async (mutate: Parameters<ConfigAccess['update']>[0]) => {
        const concurrent: ConfigSnapshot = { cfg: structuredClone(cfg), auth: emptyAuth() };
        await mutate(concurrent);
        return concurrent;
      }
    } as unknown as ConfigAccess;
    const agents = createAgentModule({ paths, config });

    await expect(
      agents.createAgent({
        name: 'Racy',
        capabilities: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        credentialIds: [CREDENTIAL_A],
        prompt: 'This must not persist.'
      })
    ).rejects.toMatchObject({ code: 'agent_credential_not_found' });

    expect({
      agents: initial.cfg.agent.agents,
      promptExists: await Bun.file(join(paths.agents, 'racy', 'AGENT.md')).exists()
    }).toEqual({ agents: [], promptExists: false });
  });

  test('prompt write failure rolls back the serialized agent create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monad-agent-credentials-'));
    roots.push(root);
    const agentsPath = join(root, 'agents-blocked-by-file');
    await Bun.write(agentsPath, 'not a directory');
    const cfg = createDefaultConfig('Test');
    const config = stubConfigAccess(cfg, emptyAuth());
    const agents = createAgentModule({ paths: makeTestPaths(root, { agents: agentsPath }), config });

    await expect(
      agents.createAgent({
        name: 'Prompt failure',
        capabilities: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        credentialIds: [],
        prompt: 'This write must fail.'
      })
    ).rejects.toBeInstanceOf(Error);

    expect({
      agents: config.get().cfg.agent.agents,
      blocker: await Bun.file(agentsPath).text()
    }).toEqual({ agents: [], blocker: 'not a directory' });
  });

  test('config persistence failure leaves a durable prompt marker that restart recovery removes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monad-agent-credentials-'));
    roots.push(root);
    const paths = makeTestPaths(root);
    const initial: ConfigSnapshot = { cfg: createDefaultConfig('Test'), auth: emptyAuth() };
    const config = {
      get: () => initial,
      status: () => ({ state: 'ready' as const }),
      subscribe: () => () => {},
      update: async (mutate: Parameters<ConfigAccess['update']>[0]) => {
        const draft = structuredClone(initial);
        await mutate(draft);
        throw new Error('config persistence failed');
      }
    } as unknown as ConfigAccess;
    const agents = createAgentModule({ paths, config });

    await expect(
      agents.createAgent({
        name: 'Config failure',
        capabilities: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        credentialIds: [],
        prompt: 'Installed before config persistence.'
      })
    ).rejects.toThrow('config persistence failed');

    expect({
      agents: initial.cfg.agent.agents,
      prompt: await Bun.file(join(paths.agents, 'config-failure', 'AGENT.md')).exists(),
      pending: await readdir(join(paths.agents, '.create-transactions'))
    }).toEqual({ agents: [], prompt: true, pending: [expect.stringMatching(/^agt_/)] });

    await recoverAgentCreateTransactions(paths.agents, initial.cfg.agent.agents);
    expect({
      prompt: await Bun.file(join(paths.agents, 'config-failure', 'AGENT.md')).exists(),
      pending: await readdir(join(paths.agents, '.create-transactions'))
    }).toEqual({ prompt: false, pending: [] });
  });

  test('delete removes the vault entry and every agent grant in one snapshot mutation', async () => {
    const cfg = createDefaultConfig('Test');
    cfg.agent.agents = [
      {
        id: AGENT_A,
        name: 'A',
        capabilities: [],
        credentialIds: [CREDENTIAL_A],
        declaredScopes: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        atoms: { mode: 'inherit', allow: [], deny: [] },
        visibility: { subagentCallable: false, public: false },
        a2a: { enabled: false },
        monadix: { consume: false }
      },
      {
        id: AGENT_B,
        name: 'B',
        capabilities: [],
        credentialIds: [CREDENTIAL_A],
        declaredScopes: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        atoms: { mode: 'inherit', allow: [], deny: [] },
        visibility: { subagentCallable: false, public: false },
        a2a: { enabled: false },
        monadix: { consume: false }
      }
    ];
    const auth = emptyAuth();
    auth.credentials[CREDENTIAL_A] = storedCredential('TOKEN');
    const snapshots: Array<{ cfg: MonadConfig; auth: MonadAuth | null }> = [];
    const root = await mkdtemp(join(tmpdir(), 'monad-agent-credentials-'));
    roots.push(root);
    const config = stubConfigAccess(cfg, auth, async (snapshot) => void snapshots.push(structuredClone(snapshot)));
    const credentials = createCredentialModule(config);

    expect(await credentials.deleteCredential(CREDENTIAL_A)).toEqual({
      ok: true,
      affectedAgentIds: [AGENT_A, AGENT_B]
    });
    expect(snapshots).toHaveLength(1);
    expect({
      credential: snapshots[0]?.auth?.credentials[CREDENTIAL_A],
      grants: snapshots[0]?.cfg.agent.agents.map((agent) => agent.credentialIds)
    }).toEqual({ credential: undefined, grants: [[], []] });
  });

  test('capability reports a stable non-secret protected-execution status', async () => {
    const { credentials } = await setup();

    expect(await credentials.getCapability()).toEqual({
      available: false,
      code: 'protected_execution_unavailable'
    });

    const launcher: SandboxLauncher = {
      kind: 'test-protected',
      descriptor: { name: 'Test protected' },
      isAvailable: () => true,
      enforces: { readDeny: true, net: ['filtered'] },
      wrap: (argv) => argv
    };
    configureProtectedCredentialResolver(() => ({
      credentials: [],
      credentialVaultContainsSecrets: false
    }));
    configureProtectedExecutionTls(true);
    configureSandboxLauncher(launcher);

    expect(await credentials.getCapability()).toEqual({ available: true });
  });
});
