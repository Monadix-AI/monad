import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { STUDIO_SECTION_COMPONENTS } from '../../features/studio/section-registry';
import {
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_SECTION_IDS,
  STUDIO_SWARM_SECTIONS,
  STUDIO_SYSTEM_SECTIONS
} from '../../features/studio/sections';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('studio section registry covers every studio section id', () => {
  expect(Object.keys(STUDIO_SECTION_COMPONENTS).sort()).toEqual([...STUDIO_SECTION_IDS].sort());
});

test('Studio sidebar separates runtime delegates from provider-owned swarm agents', () => {
  const runtimeSectionIds = STUDIO_RUNTIME_SECTIONS.map((item) => item.id);
  const swarmSectionIds = STUDIO_SWARM_SECTIONS.map((item) => item.id);

  expect(runtimeSectionIds).toContain('runtime');
  expect(runtimeSectionIds).toContain('acpDelegates');
  expect(runtimeSectionIds).not.toContain('nativeCliAgents');
  expect(swarmSectionIds).toContain('swarm');
  expect(swarmSectionIds).toContain('nativeCliAgents');
  expect(swarmSectionIds).toContain('workplaceProjects');
  expect(swarmSectionIds).not.toContain('acpDelegates');
  expect(swarmSectionIds).not.toContain('projectMembers');
  expect(swarmSectionIds).not.toContain('swarmTasks');
  expect(STUDIO_SECTION_COMPONENTS.acpAgents).toBe(STUDIO_SECTION_COMPONENTS.acpDelegates);
  expect(STUDIO_SECTION_COMPONENTS.nativeCliAgents).not.toBe(STUDIO_SECTION_COMPONENTS.acpDelegates);
  expect(STUDIO_SECTION_COMPONENTS.projectMembers).toBeDefined();
  expect(STUDIO_SECTION_COMPONENTS.swarmTasks).toBeDefined();
});

test('Studio System group holds atom packs and usage, separate from the swarm', () => {
  const systemSectionIds = STUDIO_SYSTEM_SECTIONS.map((item) => item.id);
  const swarmSectionIds = STUDIO_SWARM_SECTIONS.map((item) => item.id);
  const runtimeSectionIds = STUDIO_RUNTIME_SECTIONS.map((item) => item.id);

  expect(systemSectionIds).toEqual(['atoms', 'usage']);
  expect(swarmSectionIds).not.toContain('atoms');
  expect(swarmSectionIds).not.toContain('usage');
  expect(runtimeSectionIds).not.toContain('atoms');
  expect(runtimeSectionIds).not.toContain('usage');
});

test('ACP delegates page only manages ACP agents', () => {
  const source = readSource('features/studio/third-party-agents/index.tsx');

  expect(source).toContain('AcpAgentsSettings');
  expect(source).not.toContain('NativeCliAgentsSettings');
  expect(source).toContain('web.studio.acpDelegates');
  expect(source).toContain('web.studio.acpDelegatesDesc');
});

test('native CLI connected presets open their settings in a dialog', () => {
  const source = readSource('features/studio/third-party-agents/NativeCliAgentsSettings.tsx');

  expect(source).toContain('editingAgent');
  expect(source).toContain('Settings');
  expect(source).toContain('AgentForm');
  expect(source).toContain('setEditingAgent(null)');
});

test('studio registry does not import Studio panels from settings', () => {
  const source = readSource('features/studio/section-registry.tsx');

  expect(source).not.toContain('@/features/settings/');
});

test('Studio breadcrumb header swaps the icon slot for a fixed-height back button', () => {
  const source = readSource('features/studio/StudioBreadcrumbHeader.tsx');

  expect(source).toContain('backHref');
  expect(source).toContain('parentTitle');
  expect(source).toContain('ArrowLeft');
  expect(source).toContain('mainTitle');
});

test('agent detail pages are URL-backed Studio secondary pages', () => {
  const panel = readSource('features/studio/AgentsPanel.tsx');
  const editor = readSource('features/studio/agent-workshop/AgentEditor.tsx');

  expect(panel).toContain("studioDetailPath('agents'");
  expect(panel).toContain('subpath = []');
  expect(panel).toContain('const editing =');
  expect(panel).toContain('router.replace');
  expect(editor).toContain('StudioBreadcrumbHeader');
  expect(editor).toContain('backHref={studioPath');
  expect(editor).toContain("parentTitle={t('web.studio.agents')}");
});
