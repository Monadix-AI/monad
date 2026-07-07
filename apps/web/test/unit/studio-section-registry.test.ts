import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const _runtimeSectionIds = STUDIO_RUNTIME_SECTIONS.map((item) => item.id);
  const _meshSectionIds = STUDIO_MESH_SECTIONS.map((item) => item.id);

  expect(STUDIO_SECTION_COMPONENTS.acpAgents).toBe(STUDIO_SECTION_COMPONENTS.acpDelegates);
  expect(STUDIO_SECTION_COMPONENTS.nativeCliAgents).not.toBe(STUDIO_SECTION_COMPONENTS.acpDelegates);
});

test('Studio System group holds install-level utilities, separate from the mesh overview', () => {
  const systemSectionIds = STUDIO_SYSTEM_SECTIONS.map((item) => item.id);
  const _meshSectionIds = STUDIO_MESH_SECTIONS.map((item) => item.id);
  const _runtimeSectionIds = STUDIO_RUNTIME_SECTIONS.map((item) => item.id);

  expect(systemSectionIds).toEqual(['atoms', 'usage']);
});

test('Studio System import is a stateless link to External Agents', () => {
  const sidebarSource = readFileSync(join(import.meta.dir, '../../features/shell/SessionSidebarNav.tsx'), 'utf8');

  expect(STUDIO_SYSTEM_SECTIONS.map((item) => item.id)).not.toContain('nativeCliAgents');
  expect(sidebarSource).toContain("label={t('web.settings.import')}");
  expect(sidebarSource).toContain("onClick={() => onSelect('nativeCliAgents')}");
});
