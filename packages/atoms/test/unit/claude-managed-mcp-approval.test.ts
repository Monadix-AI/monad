import { expect, test } from 'bun:test';

import { allowManagedBridgeTools } from '../../src/agent-adapters/claude-code/index.ts';

const PLAN_TOOLS = ['project_plan_list', 'project_plan_add', 'project_plan_update', 'project_plan_delete'];

function wildcardOf(args: string[]): string {
  const idx = args.indexOf('--allowedTools');
  const wildcard = args[idx + 1];
  if (wildcard === undefined) throw new Error('managed args missing --allowedTools value');
  return wildcard;
}

// The wildcard is a shell-style prefix glob; a managed Claude session hands it to `--allowedTools`.
function matchesWildcard(pattern: string, tool: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(tool);
}

test('managed Claude session pre-approves every Monad tool with a single wildcard', () => {
  const args = allowManagedBridgeTools([], true);
  expect(args).toEqual(['--allowedTools', 'mcp__monad__*']);
});

test('managed wildcard covers the session-plan tools and rejects non-Monad tools', () => {
  const wildcard = wildcardOf(allowManagedBridgeTools([], true));
  expect(PLAN_TOOLS.map((tool) => matchesWildcard(wildcard, `mcp__monad__${tool}`))).toEqual([true, true, true, true]);
  expect(matchesWildcard(wildcard, 'mcp__other__project_plan_add')).toBe(false);
  expect(matchesWildcard(wildcard, 'Bash')).toBe(false);
});

test('unmanaged session gets no blanket Monad tool approval', () => {
  expect(allowManagedBridgeTools([], false)).toEqual([]);
});

test('an explicit caller-supplied allowedTools flag is left untouched', () => {
  expect(allowManagedBridgeTools(['--allowedTools', 'mcp__monad__project_post'], true)).toEqual([
    '--allowedTools',
    'mcp__monad__project_post'
  ]);
});
