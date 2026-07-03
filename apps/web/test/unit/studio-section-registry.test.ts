import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { STUDIO_SECTION_COMPONENTS } from '../../features/studio/section-registry';
import { STUDIO_CAPABILITY_SECTIONS, STUDIO_SECTION_IDS } from '../../features/studio/sections';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('studio section registry covers every studio section id', () => {
  expect(Object.keys(STUDIO_SECTION_COMPONENTS).sort()).toEqual([...STUDIO_SECTION_IDS].sort());
});

test('Studio sidebar merges ACP and native CLI agents into third-party agents', () => {
  const capabilitySectionIds = STUDIO_CAPABILITY_SECTIONS.map((item) => item.id);

  expect(capabilitySectionIds).toContain('thirdPartyAgents');
  expect(capabilitySectionIds).not.toContain('acpAgents');
  expect(capabilitySectionIds).not.toContain('nativeCliAgents');
  expect(STUDIO_SECTION_COMPONENTS.acpAgents).toBe(STUDIO_SECTION_COMPONENTS.thirdPartyAgents);
  expect(STUDIO_SECTION_COMPONENTS.nativeCliAgents).toBe(STUDIO_SECTION_COMPONENTS.thirdPartyAgents);
});

test('third-party agents page manages ACP and native CLI modes as cards', () => {
  const source = readSource('features/studio/third-party-agents/index.tsx');

  expect(source).toContain('AcpAgentsSettings');
  expect(source).toContain('NativeCliAgentsSettings');
  expect(source).toContain('web.thirdPartyAgents.acpMode');
  expect(source).toContain('web.thirdPartyAgents.cliMode');
  expect(source).toContain("mode === 'acp' || mode === 'cli'");
  expect(source).toContain("studioPath('thirdPartyAgents')");
  expect(source).toContain('backHref={studioPath');
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
