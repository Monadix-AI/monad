// Hot-reload of the agent_acp_delegate tool: applyAcpDelegateTool drives the LIVE registry so an
// invite/edit/enable/disable/remove takes effect without a daemon restart. The agent re-composes its
// roster whenever registry.toolRevision bumps, so these assertions track the revision + the tool's
// presence and (roster-reflecting) description.

import { expect, test } from 'bun:test';

import { applyAcpDelegateTool } from '@/bootstrap/acp-delegate.ts';
import { AtomPackRegistry } from '@/handlers/atom-pack/atom-pack-registry.ts';

const agent = (name: string, enabled = true) => ({
  name,
  command: 'npx',
  args: ['-y', 'x'],
  enabled,
  osSandbox: false,
  forwardMcp: false
});
const delegate = (r: AtomPackRegistry) => r.toolList().find((t) => t.name === 'agent_acp_delegate');

test('zero enabled agents → tool absent, no revision churn', () => {
  const r = new AtomPackRegistry();
  const rev0 = r.toolRevision;
  applyAcpDelegateTool({ registry: r, agents: [] });
  expect(delegate(r)).toBeUndefined();
  expect(r.toolRevision).toBe(rev0); // clearing nothing must not bump the agent's memo key
});

test('inviting the first agent registers the tool and bumps the revision (no restart)', () => {
  const r = new AtomPackRegistry();
  const rev0 = r.toolRevision;
  applyAcpDelegateTool({ registry: r, agents: [agent('claude-code')] });
  const tool = delegate(r);
  expect(tool).toBeDefined();
  expect(r.toolRevision).toBeGreaterThan(rev0);
  expect(tool?.description).toContain('claude-code'); // roster is advertised in the description
});

test('editing the roster refreshes the description and bumps again', () => {
  const r = new AtomPackRegistry();
  applyAcpDelegateTool({ registry: r, agents: [agent('claude-code')] });
  const rev1 = r.toolRevision;
  applyAcpDelegateTool({ registry: r, agents: [agent('claude-code'), agent('codex')] });
  const tool = delegate(r);
  expect(r.toolRevision).toBeGreaterThan(rev1);
  expect(tool?.description).toContain('codex'); // newly-invited agent is now visible to the model
  expect(tool?.description).toContain('claude-code');
});

test('disabling the last agent removes the tool and bumps the revision', () => {
  const r = new AtomPackRegistry();
  applyAcpDelegateTool({ registry: r, agents: [agent('codex')] });
  const rev1 = r.toolRevision;
  applyAcpDelegateTool({ registry: r, agents: [agent('codex', false)] }); // disabled → empty roster
  expect(delegate(r)).toBeUndefined();
  expect(r.toolRevision).toBeGreaterThan(rev1);
});

test('only enabled agents appear in the advertised roster', () => {
  const r = new AtomPackRegistry();
  applyAcpDelegateTool({ registry: r, agents: [agent('codex'), agent('claude-code', false)] });
  const tool = delegate(r);
  expect(tool?.description).toContain('codex');
  expect(tool?.description).not.toContain('claude-code');
});
