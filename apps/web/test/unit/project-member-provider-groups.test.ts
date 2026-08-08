import { expect, test } from 'bun:test';

test('groups each configurable CLI agent under its provider', async () => {
  const module = (await import('../../src/features/workplace/project-shell/ProjectAddMemberSection')) as Record<
    string,
    unknown
  >;
  const groupProjectMemberProviders = module.groupProjectMemberProviders as (candidates: unknown[]) => Array<{
    id: string;
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

  expect(groups.map((group) => ({ id: group.id, candidateIds: group.candidates.map((item) => item.id) }))).toEqual([
    {
      id: 'mesh-agent:codex',
      candidateIds: ['mesh-agent:codex']
    },
    {
      id: 'acp:researcher',
      candidateIds: ['pmem_acp_researcher']
    }
  ]);
  expect(groups[1]?.enabled).toBe(false);
});

test('groups discovered Monad, OpenClaw, and Hermes agents by provider for dialog selection', async () => {
  const { groupProjectMemberProviders } = (await import(
    '../../src/features/workplace/project-shell/ProjectAddMemberSection'
  )) as {
    groupProjectMemberProviders(candidates: unknown[]): Array<{
      id: string;
      interaction: string;
      candidates: Array<{ id: string }>;
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
      interaction: group.interaction,
      targets: group.candidates.map((item) => item.id)
    }))
  ).toEqual([
    {
      id: 'mesh-agent:monad',
      interaction: 'select-existing',
      targets: ['mesh-agent:monad--agt_researcher', 'mesh-agent:monad--agt_writer']
    },
    {
      id: 'mesh-agent:openclaw',
      interaction: 'select-existing',
      targets: ['mesh-agent:openclaw--researcher', 'mesh-agent:openclaw--writer']
    },
    {
      id: 'mesh-agent:hermes',
      interaction: 'select-existing',
      targets: ['mesh-agent:hermes--planner', 'mesh-agent:hermes--reviewer']
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
      candidates: Array<{ id: string }>;
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
      interaction: group.interaction
    }))
  ).toEqual([
    { id: 'mesh-agent:codex', interaction: 'spawn-new' },
    { id: 'mesh-agent:claude-code', interaction: 'spawn-new' },
    { id: 'mesh-agent:gemini', interaction: 'spawn-new' }
  ]);
});
