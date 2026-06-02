import { expect, test } from 'bun:test';

test('groups each configurable CLI agent under its provider', async () => {
  const module = (await import('../../src/features/workplace/project-shell/ProjectAddMemberSection')) as Record<
    string,
    unknown
  >;
  const groupProjectMemberProviders = module.groupProjectMemberProviders as (candidates: unknown[]) => Array<{
    id: string;
    label: string;
    enabled: boolean;
    candidates: Array<{ id: string }>;
  }>;
  const candidates = [
    {
      id: 'mesh-agent:codex',
      type: 'mesh-agent' as const,
      name: 'codex',
      label: 'OpenAI Codex',
      tag: 'Codex',
      enabled: true,
      provider: 'codex',
      icon: 'codex',
      modelOptions: [],
      reasoningEfforts: []
    },
    {
      id: 'pmem_acp_researcher',
      type: 'acp' as const,
      name: 'researcher',
      label: 'Researcher',
      tag: 'ACP',
      enabled: false,
      modelOptions: [],
      reasoningEfforts: []
    }
  ];

  const groups = groupProjectMemberProviders(candidates);

  expect(
    groups.map((group) => ({ id: group.id, label: group.label, candidateIds: group.candidates.map((item) => item.id) }))
  ).toEqual([
    {
      id: 'mesh-agent:codex',
      label: 'OpenAI Codex',
      candidateIds: ['mesh-agent:codex']
    },
    {
      id: 'acp:researcher',
      label: 'Researcher',
      candidateIds: ['pmem_acp_researcher']
    }
  ]);
  expect(groups[1]?.enabled).toBe(false);
});

test('formats the Antigravity provider id as its product name in Project Settings', async () => {
  const { groupProjectMemberProviders } = (await import(
    '../../src/features/workplace/project-shell/ProjectAddMemberSection'
  )) as {
    groupProjectMemberProviders(candidates: unknown[]): Array<{ id: string; label: string }>;
  };

  const groups = groupProjectMemberProviders([
    {
      id: 'mesh-agent:antigravity',
      type: 'mesh-agent',
      name: 'antigravity',
      label: 'Antigravity',
      tag: 'Antigravity',
      enabled: true,
      provider: 'antigravity',
      icon: 'antigravity',
      modelOptions: [],
      reasoningEfforts: []
    }
  ]);

  expect(groups.map(({ id, label }) => ({ id, label }))).toEqual([
    { id: 'mesh-agent:antigravity', label: 'Antigravity' }
  ]);
});

test('groups discovered Monad, OpenClaw, and Hermes agents by provider for dialog selection', async () => {
  const { groupProjectMemberProviders } = (await import(
    '../../src/features/workplace/project-shell/ProjectAddMemberSection'
  )) as {
    groupProjectMemberProviders(candidates: unknown[]): Array<{
      id: string;
      label: string;
      interaction: string;
      candidates: Array<{ id: string; label: string }>;
    }>;
  };
  const candidate = (provider: 'monad' | 'openclaw' | 'hermes', name: string, label: string) => ({
    id: `mesh-agent:${name}`,
    type: 'mesh-agent' as const,
    name,
    label,
    tag: provider === 'monad' ? 'Monad' : provider === 'openclaw' ? 'OpenClaw' : 'Hermes',
    enabled: true,
    provider,
    icon: provider,
    modelOptions: [],
    reasoningEfforts: []
  });

  const groups = groupProjectMemberProviders([
    candidate('monad', 'monad--agt_researcher', 'Researcher'),
    candidate('monad', 'monad--agt_writer', 'Writer'),
    candidate('openclaw', 'openclaw--researcher', 'Researcher'),
    candidate('openclaw', 'openclaw--writer', 'Writer'),
    candidate('hermes', 'hermes--planner', 'Planner'),
    candidate('hermes', 'hermes--reviewer', 'Reviewer')
  ]);

  expect(
    groups.map((group) => ({
      id: group.id,
      label: group.label,
      interaction: group.interaction,
      targets: group.candidates.map((item) => item.label)
    }))
  ).toEqual([
    {
      id: 'mesh-agent:monad',
      label: 'Monad',
      interaction: 'select-existing',
      targets: ['Researcher', 'Writer']
    },
    {
      id: 'mesh-agent:openclaw',
      label: 'OpenClaw',
      interaction: 'select-existing',
      targets: ['Researcher', 'Writer']
    },
    {
      id: 'mesh-agent:hermes',
      label: 'Hermes',
      interaction: 'select-existing',
      targets: ['Planner', 'Reviewer']
    }
  ]);
});

test('keeps CLI providers on the direct spawn flow', async () => {
  const { groupProjectMemberProviders } = (await import(
    '../../src/features/workplace/project-shell/ProjectAddMemberSection'
  )) as {
    groupProjectMemberProviders(candidates: unknown[]): Array<{
      id: string;
      interaction: string;
      candidates: Array<{ label: string }>;
    }>;
  };
  const cliCandidate = (provider: string, label: string) => ({
    id: `mesh-agent:${provider}`,
    type: 'mesh-agent' as const,
    name: provider,
    label,
    tag: provider,
    enabled: true,
    provider,
    icon: provider,
    modelOptions: [],
    reasoningEfforts: []
  });

  const groups = groupProjectMemberProviders([
    cliCandidate('codex', 'OpenAI Codex'),
    cliCandidate('claude-code', 'Claude'),
    cliCandidate('gemini', 'Gemini')
  ]);

  expect(
    groups.map((group) => ({
      id: group.id,
      interaction: group.interaction,
      actions: group.candidates.map((candidate) => candidate.label)
    }))
  ).toEqual([
    { id: 'mesh-agent:codex', interaction: 'spawn-new', actions: ['OpenAI Codex'] },
    { id: 'mesh-agent:claude-code', interaction: 'spawn-new', actions: ['Claude'] },
    { id: 'mesh-agent:gemini', interaction: 'spawn-new', actions: ['Gemini'] }
  ]);
});

test('uses one provider-level add action for single and multi-target providers', async () => {
  const { projectMemberProviderAction } = (await import(
    '../../src/features/workplace/project-shell/ProjectAddMemberSection'
  )) as {
    projectMemberProviderAction(group: { enabled: boolean }): { disabled: boolean; labelKey: string };
  };

  expect(projectMemberProviderAction({ enabled: true })).toEqual({
    disabled: false,
    labelKey: 'web.workplace.addMember'
  });
  expect(projectMemberProviderAction({ enabled: false })).toEqual({
    disabled: true,
    labelKey: 'web.workplace.addMember'
  });
});

test('uses the member type for the remove action label', async () => {
  const module = (await import('../../src/features/workplace/project-shell/ProjectSettings')) as Record<
    string,
    unknown
  >;
  const projectMemberRemoveLabelKey = module.projectMemberRemoveLabelKey as (type: string) => string;

  expect(projectMemberRemoveLabelKey('mesh-agent')).toBe('web.workplace.removeCliMember');
  expect(projectMemberRemoveLabelKey('acp')).toBe('web.workplace.removeAcpMember');
});
