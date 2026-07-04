import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { STUDIO_SECTION_COMPONENTS } from '../../features/studio/section-registry';
import {
  STUDIO_MESH_SECTIONS,
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_SECTION_IDS,
  STUDIO_SYSTEM_SECTIONS
} from '../../features/studio/sections';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('studio section registry covers every studio section id', () => {
  expect(Object.keys(STUDIO_SECTION_COMPONENTS).sort()).toEqual([...STUDIO_SECTION_IDS].sort());
});

test('Studio sidebar separates runtime delegates from provider-owned mesh agents', () => {
  const runtimeSectionIds = STUDIO_RUNTIME_SECTIONS.map((item) => item.id);
  const meshSectionIds = STUDIO_MESH_SECTIONS.map((item) => item.id);

  expect(runtimeSectionIds).toContain('runtime');
  expect(runtimeSectionIds).toContain('acpDelegates');
  expect(runtimeSectionIds).not.toContain('nativeCliAgents');
  expect(meshSectionIds).toContain('mesh');
  expect(meshSectionIds).toContain('nativeCliAgents');
  expect(meshSectionIds).toContain('workplaceProjects');
  expect(meshSectionIds).not.toContain('acpDelegates');
  expect(meshSectionIds).not.toContain('projectMembers');
  expect(meshSectionIds).not.toContain('meshTasks');
  expect(STUDIO_SECTION_COMPONENTS.acpAgents).toBe(STUDIO_SECTION_COMPONENTS.acpDelegates);
  expect(STUDIO_SECTION_COMPONENTS.nativeCliAgents).not.toBe(STUDIO_SECTION_COMPONENTS.acpDelegates);
  expect(STUDIO_SECTION_COMPONENTS.projectMembers).toBeDefined();
  expect(STUDIO_SECTION_COMPONENTS.meshTasks).toBeDefined();
});

test('Studio System group holds atom packs and usage, separate from the mesh', () => {
  const systemSectionIds = STUDIO_SYSTEM_SECTIONS.map((item) => item.id);
  const meshSectionIds = STUDIO_MESH_SECTIONS.map((item) => item.id);
  const runtimeSectionIds = STUDIO_RUNTIME_SECTIONS.map((item) => item.id);

  expect(systemSectionIds).toEqual(['atoms', 'usage']);
  expect(meshSectionIds).not.toContain('atoms');
  expect(meshSectionIds).not.toContain('usage');
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
