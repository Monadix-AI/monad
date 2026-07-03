import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const settingsSource = () => readSource('features/workplace/project-shell/ProjectSettings.tsx');

test('project settings exposes a two-step project delete action', () => {
  const source = settingsSource();

  expect(source).toContain("t('web.workplace.dangerZone')");
  expect(source).toContain("t('web.workplace.deleteProject')");
  expect(source).toContain("t('web.workplace.confirmDeleteProject')");
  expect(source).toContain('setConfirmDelete(true)');
  expect(source).toContain('await room.deleteProject();');
});

test('project delete bubbles to workspace navigation after session deletion', () => {
  const workplace = readSource('features/workplace/Workplace.tsx');
  const route = readSource('features/routes/workspace/WorkspaceRoute.tsx');
  const shell = readSource('features/shell/AppShell.tsx');

  expect(workplace).toContain('onDeleted={onProjectDeleted}');
  expect(route).toContain('onProjectDeleted={onProjectDeleted}');
  expect(shell).toContain('onProjectDeleted: setWorkspaceUrl');
});

test('project member settings use dialogs instead of inline expansion panels', () => {
  const source = settingsSource();

  expect(source).toContain('setNativeCliInvite({');
  expect(source).toContain('nativeCliMemberDialogStateForMember');
  expect(source).toContain('<ProjectMemberSettingsDialog');
  expect(source).not.toContain('const [expanded, setExpanded]');
  expect(source).not.toContain('isExpanded');
});

test('system message observation action uses observe semantics', () => {
  const followButtonSource = readSource('features/workplace/activity/SystemMessageRow.tsx');

  expect(followButtonSource).toContain("aria-label={t('web.workplace.observe')}");
  expect(followButtonSource).toContain("title={t('web.workplace.observe')}");
  expect(followButtonSource).not.toContain('<span>Follow</span>');
});

test('agent card opens member settings without opening project settings', () => {
  const source = readSource('features/workplace/Workplace.tsx');

  expect(source).toContain('openProjectMemberSettings(projectId, memberId)');
  expect(source).not.toContain('openProjectSettingsInStore(projectId, memberId)');
  expect(source).toContain('<ProjectMemberDialog');
});

test('native CLI spawn dialog shows pending feedback while spawning', () => {
  const source = readSource('features/workplace/project-shell/NativeCliMemberDialog.tsx');

  expect(source).toContain('const [saving, setSaving]');
  expect(source).toContain('setSaving(false)');
  expect(source).toContain('setSaving(true)');
  expect(source).toContain('disabled={saving}');
  expect(source).toContain("t('web.workplace.spawningAgentMember')");
});

test('project settings delegates member dialog bodies to focused files', () => {
  const source = settingsSource();
  const lineCount = source.split('\n').length;

  expect(source).toContain("from './NativeCliMemberDialog'");
  expect(source).toContain("from './ProjectAddMemberSection'");
  expect(source).toContain("from './ProjectMemberSettingsDialog'");
  expect(lineCount).toBeLessThan(400);
});
