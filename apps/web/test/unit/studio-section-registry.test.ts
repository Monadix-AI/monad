import { expect, test } from 'bun:test';

import { STUDIO_SECTION_COMPONENTS } from '../../features/studio/section-registry';
import {
  STUDIO_MESH_SECTIONS,
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_SECTION_IDS,
  STUDIO_SYSTEM_SECTIONS
} from '../../features/studio/sections';

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
