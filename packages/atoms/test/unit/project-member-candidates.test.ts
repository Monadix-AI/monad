import { expect, test } from 'bun:test';

import { projectMemberCandidates } from '../../src/workplace-experiences/experience/project-projection.ts';
import { createWorkplaceExperienceAgentIdentityResolver } from '../../src/workplace-experiences/experience/use-workspace-project-projection.ts';

test('project member candidates expose one configurable candidate per MeshAgent provider', () => {
  const candidates = projectMemberCandidates({
    acpAgents: [],
    projectMembers: [],
    meshAgents: [
      {
        name: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        icon: { title: 'Adapter Codex', path: 'M2 2h20v20H2z' },
        enabled: true,
        allowAutopilot: false,
        capabilities: {
          auth: 'pty',
          events: 'paged',
          resume: 'structured',
          approval: 'provider-owned',
          autopilot: true,
          fastMode: true
        },
        source: 'configured-mesh-agent',
        modelOptions: ['gpt-5.5'],
        modelOptionDisplayNames: { 'gpt-5.5': 'GPT-5.5' },
        speedsByModel: { 'gpt-5.5': ['fast'] },
        reasoningEfforts: ['medium', 'high']
      }
    ]
  });

  expect(candidates).toContainEqual(
    expect.objectContaining({
      id: 'mesh-agent:codex',
      type: 'mesh-agent',
      name: 'codex',
      label: 'OpenAI Codex',
      tag: 'Codex',
      enabled: true,
      provider: 'codex',
      modelOptions: ['gpt-5.5'],
      modelOptionDisplayNames: { 'gpt-5.5': 'GPT-5.5' },
      speedsByModel: { 'gpt-5.5': ['fast'] },
      reasoningEfforts: ['medium', 'high'],
      executionCapabilities: { autopilot: true, fastMode: true },
      providerIcon: { title: 'Adapter Codex', path: 'M2 2h20v20H2z' }
    })
  );
});

test('the experience host resolves a session member name with its provider adapter icon', () => {
  const providerIcon = { title: 'Adapter Codex', path: 'M2 2h20v20H2z' };
  const candidates = projectMemberCandidates({
    acpAgents: [],
    projectMembers: [],
    meshAgents: [
      {
        name: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        icon: providerIcon,
        enabled: true,
        allowAutopilot: false,
        source: 'configured-mesh-agent'
      }
    ]
  });
  const resolveIdentity = createWorkplaceExperienceAgentIdentityResolver(
    [
      {
        id: 'pmem_reviewer',
        av: 'RV',
        kind: 'agent',
        metadata: { agent: 'codex' },
        name: 'Reviewer',
        presence: 'online',
        tag: 'Codex'
      }
    ],
    candidates
  );

  expect(resolveIdentity({ id: 'pmem_reviewer' })).toEqual({
    id: 'pmem_reviewer',
    av: 'RV',
    name: 'Reviewer',
    providerIcon,
    tag: 'Codex'
  });
});

test('discovered provider agents keep raw display names and provider identity', () => {
  const candidates = projectMemberCandidates({
    acpAgents: [],
    projectMembers: [],
    meshAgents: [
      {
        name: 'openclaw--test',
        displayName: 'test',
        provider: 'openclaw',
        productIcon: 'openclaw',
        enabled: true,
        allowAutopilot: false,
        source: 'configured-mesh-agent'
      },
      {
        name: 'hermes--test',
        displayName: 'test',
        provider: 'hermes',
        productIcon: 'hermes',
        enabled: true,
        allowAutopilot: false,
        source: 'configured-mesh-agent'
      }
    ]
  });

  expect(candidates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'openclaw--test', label: 'test', tag: 'OpenClaw', icon: 'openclaw' }),
      expect.objectContaining({ name: 'hermes--test', label: 'test', tag: 'Hermes', icon: 'hermes' })
    ])
  );
});
