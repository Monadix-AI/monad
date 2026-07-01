import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { STUDIO_SECTION_COMPONENTS } from '../../features/studio/section-registry';
import { STUDIO_CAPABILITY_SECTIONS, STUDIO_SECTION_IDS } from '../../features/studio/sections';

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
  const source = readFileSync('apps/web/features/settings/ThirdPartyAgentsSettings.tsx', 'utf8');

  expect(source).toContain('AcpAgentsSettings');
  expect(source).toContain('NativeCliAgentsSettings');
  expect(source).toContain('web.thirdPartyAgents.acpMode');
  expect(source).toContain('web.thirdPartyAgents.cliMode');
  expect(source).toContain('<Switch');
  expect(source).toContain("studioDetailPath('thirdPartyAgents', 'acp')");
  expect(source).toContain("studioDetailPath('thirdPartyAgents', 'cli')");
  expect(source).toContain('backHref={studioPath');
});

test('Studio breadcrumb header swaps the icon slot for a fixed-height back button', () => {
  const source = readFileSync('apps/web/features/studio/StudioBreadcrumbHeader.tsx', 'utf8');

  expect(source).toContain('backHref');
  expect(source).toContain('parentTitle');
  expect(source).toContain('ArrowLeft');
  expect(source).toContain('size-7');
  expect(source).toContain('iconSlot');
  expect(source).toContain('mainTitle');
});

test('agent detail pages are URL-backed Studio secondary pages', () => {
  const panel = readFileSync('apps/web/features/studio/AgentsPanel.tsx', 'utf8');
  const editor = readFileSync('apps/web/features/studio/agent-workshop/AgentEditor.tsx', 'utf8');

  expect(panel).toContain("studioDetailPath('agents'");
  expect(panel).toContain('studioSubpathFromPathname');
  expect(panel).toContain('router.replace');
  expect(editor).toContain('StudioBreadcrumbHeader');
  expect(editor).toContain('backHref={studioPath');
  expect(editor).toContain("parentTitle={t('web.studio.agents')}");
});
