import type { ReactElement } from 'react';

import { expect, test } from 'bun:test';

import { installedSkillAllowlist } from '#/features/studio/agent-workshop/panels/SkillsPanel';
import { ADD_SKILL_SOURCES, AddSkillMenuItems } from '#/features/studio/skills-settings/AddSkillDialog';

test('Add Skill dropdown offers exactly GitHub, Upload, and Create sources', () => {
  const selected: string[] = [];
  const items = AddSkillMenuItems({
    onSelect: (source) => selected.push(source),
    translate: (key) => key
  }) as ReactElement<{
    'data-skill-source': string;
    onSelect: () => void;
  }>[];

  for (const item of items) item.props.onSelect();

  expect({
    configuredSources: ADD_SKILL_SOURCES,
    renderedSources: items.map((item) => item.props['data-skill-source']),
    selected
  }).toEqual({
    configuredSources: ['github', 'upload', 'create'],
    renderedSources: ['github', 'upload', 'create'],
    selected: ['github', 'upload', 'create']
  });
});

test('Agent installs extend only an explicit Skill allowlist', () => {
  const current = ['global:existing'];
  const installed = ['agent:private-agent:github', 'agent:private-agent:upload'];

  expect({
    allowlist: installedSkillAllowlist('allowlist', current, installed),
    inherit: installedSkillAllowlist('inherit', current, installed)
  }).toEqual({
    allowlist: ['global:existing', 'agent:private-agent:github', 'agent:private-agent:upload'],
    inherit: current
  });
});
