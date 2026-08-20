import type { MonadConfig, MonadPaths } from '@monad/environment';
import type { AgentAtoms, AgentMemorySettings } from '@monad/protocol';
import type { LoadedSkill } from '#/agent/index.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyAuth } from '@monad/environment';

import { AgentPersonaService, isToolExposed, type SessionAgentLookup } from '#/services/generation/agent-persona.ts';
import { writeAgentBody, writeAgentPromptSlots } from '#/store/home/agent-def.ts';

describe('isToolExposed (per-agent atoms policy)', () => {
  const allowlist = { mode: 'allowlist' as const, allow: ['playwright', 'file_write'], deny: ['shell_exec'] };
  const inherit = { mode: 'inherit' as const, allow: [], deny: ['shell_exec'] };

  test('undefined policy exposes everything', () => {
    expect(isToolExposed(undefined, 'anything', 'somepack')).toBe(true);
  });

  test('deny removes by tool name or source, beating everything', () => {
    expect(isToolExposed(inherit, 'shell_exec')).toBe(false);
    expect(isToolExposed(allowlist, 'shell_exec', 'playwright')).toBe(false); // denied by tool name
    expect(isToolExposed({ mode: 'inherit', allow: [], deny: ['badpack'] }, 'x', 'badpack')).toBe(false);
  });

  test('inherit exposes all non-denied', () => {
    expect(isToolExposed(inherit, 'read_file', 'somepack')).toBe(true);
    expect(isToolExposed(inherit, 'file_read')).toBe(true);
  });

  test('allowlist requires a built-in tool name or pack/server source', () => {
    expect(isToolExposed(allowlist, 'file_read')).toBe(false);
    expect(isToolExposed(allowlist, 'file_write')).toBe(true);
    expect(isToolExposed(allowlist, 'click', 'playwright')).toBe(true); // source allowed
    expect(isToolExposed(allowlist, 'file_write', 'somepack')).toBe(true); // exact tool name allowed
    expect(isToolExposed(allowlist, 'query', 'notion')).toBe(false); // source not in allow
  });

  test('allowlist accepts the built-in capability identifiers shown by the Agent editor', () => {
    const policy: AgentAtoms = { mode: 'allowlist', allow: ['tool:file-system'], deny: [] };
    expect(isToolExposed(policy, 'file_read')).toBe(true);
    expect(isToolExposed(policy, 'file_write')).toBe(true);
    expect(isToolExposed(policy, 'shell_exec')).toBe(false);
  });
});

type SandboxMode = 'workspace' | 'home' | 'ephemeral' | 'unrestricted';

function fakeConfig(
  agents: {
    id: string;
    name: string;
    dir?: string;
    atoms?: AgentAtoms;
    memory?: AgentMemorySettings;
    sandbox?: { mode: SandboxMode };
    skills?: {
      mode?: 'inherit' | 'allowlist';
      allow?: string[];
      autoload?: boolean;
      disabled: string[];
    };
    credentialIds?: string[];
  }[],
  globalSandbox: { enabled: boolean; mode: SandboxMode } = { enabled: false, mode: 'workspace' }
): MonadConfig {
  return {
    agent: {
      globalSandbox,
      agents: agents.map(({ atoms, memory, sandbox, skills, ...a }) => ({
        ...a,
        capabilities: [],
        credentialIds: a.credentialIds ?? [],
        declaredScopes: [],
        atoms: atoms ?? { mode: 'inherit', allow: [], deny: [] },
        sandbox,
        skills,
        memory: memory ?? {
          enabled: true,
          advanced: true,
          autoConsolidate: false,
          intervalMinutes: 30
        },
        visibility: { subagentCallable: false, public: false }
      }))
    }
  } as unknown as MonadConfig;
}

function fakeStore(map: Record<string, string[]>): SessionAgentLookup {
  return { getSession: (id) => (map[id] ? { agentIds: map[id] } : null) };
}

describe('AgentPersonaService', () => {
  let agentsDir: string;
  beforeEach(async () => {
    agentsDir = await mkdtemp(join(tmpdir(), 'monad-persona-'));
  });
  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
  });

  const paths = () => ({ agents: agentsDir }) as unknown as MonadPaths;

  test('resolves a session to its agent AGENT.md body', async () => {
    await writeAgentBody(agentsDir, 'researcher', { name: 'Researcher' }, 'You are a careful researcher.');
    const cfg = fakeConfig([{ id: 'agt_R00000000000', name: 'Researcher', dir: 'researcher' }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_100000000000: ['agt_R00000000000'] }));
    await svc.reload(cfg);
    expect(svc.resolve('ses_100000000000')).toBe('You are a careful researcher.');
  });

  test('resolves all prompt slots for the session agent', async () => {
    await writeAgentPromptSlots(
      agentsDir,
      'researcher',
      { name: 'Researcher' },
      {
        agent: 'Research primary sources.',
        user: 'Prefer concise reports.'
      }
    );
    const cfg = fakeConfig([{ id: 'agt_R00000000000', name: 'Researcher', dir: 'researcher' }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_100000000000: ['agt_R00000000000'] }));
    await svc.reload(cfg);

    expect(svc.resolvePromptSlots('ses_100000000000')).toEqual({
      agent: 'Research primary sources.',
      user: 'Prefer concise reports.'
    });
  });

  test('projects only non-secret fields for the bound agent Credentials', async () => {
    const credentialId = 'cred_000000PROMPT';
    const cfg = fakeConfig([
      {
        id: 'agt_R00000000000',
        name: 'Researcher',
        dir: 'researcher',
        credentialIds: [credentialId]
      }
    ]);
    const auth = emptyAuth();
    auth.credentials[credentialId] = {
      label: 'Primary API',
      description: 'Read production metrics',
      environmentVariable: 'PRIMARY_API_TOKEN',
      secret: 'prompt-source-secret-canary',
      allowedHosts: ['api.example.com'],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    };
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_100000000000: ['agt_R00000000000'] }));

    expect(svc.credentialManifestFor('ses_100000000000', { cfg, auth })).toEqual([
      {
        label: 'Primary API',
        description: 'Read production metrics',
        environmentVariable: 'PRIMARY_API_TOKEN',
        allowedHosts: ['api.example.com']
      }
    ]);
  });

  test('undefined for unknown session, no sessionId, or agent without an AGENT.md', async () => {
    const cfg = fakeConfig([{ id: 'agt_X00000000000', name: 'No Prompt', dir: 'no-prompt' }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_100000000000: ['agt_X00000000000'] }));
    await svc.reload(cfg);
  });

  // The Stage B wiring (main.ts agentToolFilter): session → atomsFor → isToolExposed, with the
  // registry resolving each tool's source name. A session bound to an allowlist agent must not see a
  // denied/un-allowed tool, while exact built-ins and allow-listed sources stay visible.
  test('atomsFor + isToolExposed narrows a bound session to its allowlist', async () => {
    const atoms: AgentAtoms = { mode: 'allowlist', allow: ['playwright', 'file_read'], deny: ['shell_exec'] };
    const cfg = fakeConfig([{ id: 'agt_A00000000000', name: 'Allowlisted', dir: 'allowlisted', atoms }]);
    const svc = new AgentPersonaService(
      paths(),
      fakeStore({ ses_100000000000: ['agt_A00000000000'], ses_free00000000: [] })
    );
    await svc.reload(cfg);

    const sourceOf: Record<string, string | undefined> = { click: 'playwright', query: 'notion', shell_exec: 'shell' };
    const filterFor = (sid: string) => {
      const a = svc.atomsFor(sid);
      return a ? (name: string) => isToolExposed(a, name, sourceOf[name]) : undefined;
    };

    const filter = filterFor('ses_100000000000');
    expect(filter?.('file_read')).toBe(true);
    expect(filter?.('click')).toBe(true); // source 'playwright' allowed
    expect(filter?.('query')).toBe(false); // source 'notion' not allowed
    expect(filter?.('shell_exec')).toBe(false); // denied
  });

  test('toolAllowed hides Agent Memory tools when Memory is disabled', async () => {
    const cfg = fakeConfig([
      {
        id: 'agt_A00000000000',
        name: 'Memory Off',
        memory: { enabled: false, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
      }
    ]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_100000000000: ['agt_A00000000000'] }));
    await svc.reload(cfg);

    expect({
      forget: svc.toolAllowed('ses_100000000000', 'memory_forget', undefined),
      recall: svc.toolAllowed('ses_100000000000', 'memory_recall', undefined),
      remember: svc.toolAllowed('ses_100000000000', 'memory_remember', undefined),
      fileRead: svc.toolAllowed('ses_100000000000', 'file_read', undefined)
    }).toEqual({
      forget: false,
      recall: false,
      remember: false,
      fileRead: true
    });
  });

  test('skillsFor exposes only the bound agent private skills and applies its autoload switches', async () => {
    const cfg = fakeConfig([
      {
        id: 'agt_A00000000000',
        name: 'Alpha',
        dir: 'alpha',
        skills: {
          mode: 'allowlist',
          allow: ['global:enabled', 'agent:alpha:private'],
          autoload: true,
          disabled: ['global:disabled']
        }
      },
      { id: 'agt_B00000000000', name: 'Beta', dir: 'beta' }
    ]);
    const svc = new AgentPersonaService(
      paths(),
      fakeStore({
        ses_a00000000000: ['agt_A00000000000'],
        ses_b00000000000: ['agt_B00000000000']
      })
    );
    await svc.reload(cfg);
    const skills: LoadedSkill[] = [
      { name: 'global:enabled', description: 'Enabled', body: 'enabled', dir: '/global/enabled' },
      { name: 'global:disabled', description: 'Disabled', body: 'disabled', dir: '/global/disabled' },
      { name: 'agent:alpha:private', description: 'Alpha', body: 'alpha', dir: '/agents/alpha/private' },
      { name: 'agent:beta:private', description: 'Beta', body: 'beta', dir: '/agents/beta/private' }
    ];

    expect(svc.skillsFor('ses_a00000000000', skills).map((skill) => [skill.name, skill.modelInvocable])).toEqual([
      ['global:enabled', undefined],
      ['global:disabled', false],
      ['agent:alpha:private', undefined]
    ]);
    expect(svc.skillsFor('ses_b00000000000', skills).map((skill) => skill.name)).toEqual([
      'global:enabled',
      'global:disabled',
      'agent:beta:private'
    ]);
    expect(svc.skillsFor(undefined, skills).map((skill) => skill.name)).toEqual(['global:enabled', 'global:disabled']);
  });

  test('privateCapabilityAllowed restricts private MCP sources to their owning agent', async () => {
    const cfg = fakeConfig([
      { id: 'agt_A00000000000', name: 'Alpha', dir: 'alpha' },
      { id: 'agt_B00000000000', name: 'Beta', dir: 'beta' }
    ]);
    const svc = new AgentPersonaService(
      paths(),
      fakeStore({
        ses_a00000000000: ['agt_A00000000000'],
        ses_b00000000000: ['agt_B00000000000']
      })
    );
    await svc.reload(cfg);

    expect(svc.privateCapabilityAllowed('ses_a00000000000', 'agent:alpha:mcp:linear')).toBe(true);
    expect(svc.privateCapabilityAllowed('ses_b00000000000', 'agent:alpha:mcp:linear')).toBe(false);
    expect(svc.privateCapabilityAllowed(undefined, 'agent:alpha:mcp:linear')).toBe(false);
    expect(svc.privateCapabilityAllowed('ses_a00000000000', 'linear')).toBeUndefined();
  });

  // Per-agent sandbox enforcement (main.ts agentSandboxRoots): session → bound agent's sandbox override
  // → fs roots, global ceiling applied. Narrow-only: workspace jails to the agent's own dir, home to the
  // home dir; ephemeral/unrestricted yield undefined (inherit the daemon default / defer to ephemeral).
  test('sandboxRootsFor maps the bound agent sandbox override to fs roots', async () => {
    const cfg = fakeConfig([
      { id: 'agt_W00000000000', name: 'Workspaced', dir: 'workspaced', sandbox: { mode: 'workspace' } },
      { id: 'agt_H00000000000', name: 'Homed', dir: 'homed', sandbox: { mode: 'home' } },
      { id: 'agt_E00000000000', name: 'Ephem', dir: 'ephem', sandbox: { mode: 'ephemeral' } },
      { id: 'agt_U00000000000', name: 'Unrest', dir: 'unrest', sandbox: { mode: 'unrestricted' } },
      { id: 'agt_N00000000000', name: 'NoOverride', dir: 'noov' }
    ]);
    const svc = new AgentPersonaService(
      paths(),
      fakeStore({
        ses_w00000000000: ['agt_W00000000000'],
        ses_h00000000000: ['agt_H00000000000'],
        ses_e00000000000: ['agt_E00000000000'],
        ses_u00000000000: ['agt_U00000000000'],
        ses_n00000000000: ['agt_N00000000000']
      })
    );
    await svc.reload(cfg);

    expect(svc.sandboxRootsFor('ses_w00000000000')).toEqual([join(agentsDir, 'workspaced')]);
    expect(svc.sandboxRootsFor('ses_h00000000000')).toEqual([homedir()]);
    expect(svc.sandboxRootsFor('ses_n00000000000')).toEqual([join(agentsDir, 'noov')]);
  });

  test('global sandbox ceiling overrides a looser per-agent mode', async () => {
    // globalSandbox enabled with mode 'workspace' must clamp an agent that asked for 'home'.
    const cfg = fakeConfig([{ id: 'agt_H00000000000', name: 'Homed', dir: 'homed', sandbox: { mode: 'home' } }], {
      enabled: true,
      mode: 'workspace'
    });
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_h00000000000: ['agt_H00000000000'] }));
    await svc.reload(cfg);
    expect(svc.sandboxRootsFor('ses_h00000000000')).toEqual([join(agentsDir, 'homed')]);
  });

  test('reload picks up a newly written prompt', async () => {
    const cfg = fakeConfig([{ id: 'agt_R00000000000', name: 'Researcher', dir: 'researcher' }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_100000000000: ['agt_R00000000000'] }));
    await svc.reload(cfg);
    await writeAgentBody(agentsDir, 'researcher', { name: 'Researcher' }, 'Now I have a persona.');
    await svc.reload();
    expect(svc.resolve('ses_100000000000')).toBe('Now I have a persona.');
  });
});
