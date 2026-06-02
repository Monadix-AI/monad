import type { MonadConfig, MonadPaths } from '@monad/home';
import type { AgentAtoms } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentPersonaService, isToolExposed, type SessionAgentLookup } from '@/services/generation/agent-persona.ts';
import { writeAgentBody } from '@/store/home/agent-def.ts';

describe('isToolExposed (per-agent atoms policy)', () => {
  const allowlist = { mode: 'allowlist' as const, allow: ['playwright', 'fs_write'], deny: ['shell_exec'] };
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
    expect(isToolExposed(inherit, 'fs_read')).toBe(true);
  });

  test('allowlist: built-ins ungated, pack/server tools need their source (or name) allowed', () => {
    expect(isToolExposed(allowlist, 'fs_read')).toBe(true); // built-in (no source) — ungated
    expect(isToolExposed(allowlist, 'click', 'playwright')).toBe(true); // source allowed
    expect(isToolExposed(allowlist, 'fs_write', 'somepack')).toBe(true); // exact tool name allowed
    expect(isToolExposed(allowlist, 'query', 'notion')).toBe(false); // source not in allow
  });
});

type SandboxMode = 'workspace' | 'home' | 'ephemeral' | 'unrestricted';

function fakeConfig(
  agents: { id: string; name: string; dir?: string; atoms?: AgentAtoms; sandbox?: { mode: SandboxMode } }[],
  globalSandbox: { enabled: boolean; mode: SandboxMode } = { enabled: false, mode: 'workspace' }
): MonadConfig {
  return {
    agent: {
      globalSandbox,
      agents: agents.map(({ atoms, sandbox, ...a }) => ({
        ...a,
        capabilities: [],
        declaredScopes: [],
        atoms: atoms ?? { mode: 'inherit', allow: [], deny: [] },
        sandbox,
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
    const cfg = fakeConfig([{ id: 'agt_R', name: 'Researcher', dir: 'researcher' }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_1: ['agt_R'] }));
    await svc.reload(cfg);
    expect(svc.resolve('ses_1')).toBe('You are a careful researcher.');
  });

  test('undefined for unknown session, no sessionId, or agent without an AGENT.md', async () => {
    const cfg = fakeConfig([{ id: 'agt_X', name: 'No Prompt', dir: 'no-prompt' }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_1: ['agt_X'] }));
    await svc.reload(cfg);
    expect(svc.resolve(undefined)).toBeUndefined();
    expect(svc.resolve('ses_unknown')).toBeUndefined();
    expect(svc.resolve('ses_1')).toBeUndefined(); // agent has no AGENT.md on disk
  });

  // The Stage B wiring (main.ts agentToolFilter): session → atomsFor → isToolExposed, with the
  // registry resolving each tool's source name. A session bound to an allowlist agent must not see a
  // denied/un-allowed pack tool, while built-ins and allow-listed sources stay visible.
  test('atomsFor + isToolExposed narrows a bound session to its allowlist', async () => {
    const atoms: AgentAtoms = { mode: 'allowlist', allow: ['playwright'], deny: ['shell_exec'] };
    const cfg = fakeConfig([{ id: 'agt_A', name: 'Allowlisted', dir: 'allowlisted', atoms }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_1: ['agt_A'], ses_free: [] }));
    await svc.reload(cfg);

    const sourceOf: Record<string, string | undefined> = { click: 'playwright', query: 'notion', shell_exec: 'shell' };
    const filterFor = (sid: string) => {
      const a = svc.atomsFor(sid);
      return a ? (name: string) => isToolExposed(a, name, sourceOf[name]) : undefined;
    };

    const filter = filterFor('ses_1');
    expect(filter).toBeDefined();
    expect(filter?.('fs_read')).toBe(true); // built-in — ungated
    expect(filter?.('click')).toBe(true); // source 'playwright' allowed
    expect(filter?.('query')).toBe(false); // source 'notion' not allowed
    expect(filter?.('shell_exec')).toBe(false); // denied
    expect(filterFor('ses_free')).toBeUndefined(); // unbound session — unrestricted
  });

  // Per-agent sandbox enforcement (main.ts agentSandboxRoots): session → bound agent's sandbox override
  // → fs roots, global ceiling applied. Narrow-only: workspace jails to the agent's own dir, home to the
  // home dir; ephemeral/unrestricted yield undefined (inherit the daemon default / defer to ephemeral).
  test('sandboxRootsFor maps the bound agent sandbox override to fs roots', async () => {
    const cfg = fakeConfig([
      { id: 'agt_W', name: 'Workspaced', dir: 'workspaced', sandbox: { mode: 'workspace' } },
      { id: 'agt_H', name: 'Homed', dir: 'homed', sandbox: { mode: 'home' } },
      { id: 'agt_E', name: 'Ephem', dir: 'ephem', sandbox: { mode: 'ephemeral' } },
      { id: 'agt_U', name: 'Unrest', dir: 'unrest', sandbox: { mode: 'unrestricted' } },
      { id: 'agt_N', name: 'NoOverride', dir: 'noov' }
    ]);
    const svc = new AgentPersonaService(
      paths(),
      fakeStore({ ses_w: ['agt_W'], ses_h: ['agt_H'], ses_e: ['agt_E'], ses_u: ['agt_U'], ses_n: ['agt_N'] })
    );
    await svc.reload(cfg);

    expect(svc.sandboxRootsFor('ses_w')).toEqual([join(agentsDir, 'workspaced')]);
    expect(svc.sandboxRootsFor('ses_h')).toEqual([homedir()]);
    expect(svc.sandboxRootsFor('ses_e')).toBeUndefined(); // ephemeral → defer to SessionSandboxService
    expect(svc.sandboxRootsFor('ses_u')).toBeUndefined(); // unrestricted → never widen from here
    expect(svc.sandboxRootsFor('ses_n')).toBeUndefined(); // no per-agent override → inherit daemon default
    expect(svc.sandboxRootsFor(undefined)).toBeUndefined();
  });

  test('global sandbox ceiling overrides a looser per-agent mode', async () => {
    // globalSandbox enabled with mode 'workspace' must clamp an agent that asked for 'home'.
    const cfg = fakeConfig([{ id: 'agt_H', name: 'Homed', dir: 'homed', sandbox: { mode: 'home' } }], {
      enabled: true,
      mode: 'workspace'
    });
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_h: ['agt_H'] }));
    await svc.reload(cfg);
    expect(svc.sandboxRootsFor('ses_h')).toEqual([join(agentsDir, 'homed')]);
  });

  test('reload picks up a newly written prompt', async () => {
    const cfg = fakeConfig([{ id: 'agt_R', name: 'Researcher', dir: 'researcher' }]);
    const svc = new AgentPersonaService(paths(), fakeStore({ ses_1: ['agt_R'] }));
    await svc.reload(cfg);
    expect(svc.resolve('ses_1')).toBeUndefined();
    await writeAgentBody(agentsDir, 'researcher', { name: 'Researcher' }, 'Now I have a persona.');
    await svc.reload();
    expect(svc.resolve('ses_1')).toBe('Now I have a persona.');
  });
});
