import type { ViewItem } from '../../src/features/session/chat-view-items';

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { sessionTranscriptHeaderState } from '../../src/features/session/SessionTranscript.tsx';
import { sessionMessageOutlineItems } from '../../src/features/session/session-message-outline';

test('sessionMessageOutlineItems indexes only user messages against all rendered rows', () => {
  const items = [
    { id: 'u1', role: 'user', text: '  First\n question ' },
    { id: 'tool1', kind: 'tool', tool: 'read', input: {}, status: 'done' },
    { id: 'a1', role: 'assistant', text: 'Answer' },
    { id: 'u2', role: 'user', text: '' }
  ] as ViewItem[];

  expect(sessionMessageOutlineItems(items, (number) => `Message ${number}`, 'Time unavailable')).toEqual([
    {
      id: 'u1',
      index: 0,
      label: 'First question',
      preview: '  First\n question ',
      time: 'Time unavailable'
    },
    {
      id: 'u2',
      index: 3,
      label: 'Message 4',
      preview: '',
      time: 'Time unavailable'
    }
  ]);
});

test('session transcript content width includes its horizontal padding', () => {
  const styles = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');
  const transcriptSource = readFileSync(
    new URL('../../src/features/session/SessionTranscript.tsx', import.meta.url),
    'utf8'
  );
  const composerSource = readFileSync(
    new URL('../../src/features/session/SessionComposerRegion.tsx', import.meta.url),
    'utf8'
  );

  expect(styles).toMatch(
    /\.session-content-column\s*{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*max-width:\s*800px;[^}]*padding-inline:\s*24px;[^}]*margin-inline:\s*auto;[^}]*}/s
  );
  expect(transcriptSource).toContain('session-content-column');
  expect(composerSource).toContain('session-content-column');
  expect(transcriptSource).not.toContain('SESSION_TRANSCRIPT_CONTENT_CLASS');
  expect(transcriptSource).not.toContain('SESSION_CONTENT_CLASS');
  expect(composerSource).not.toContain('SESSION_CONTENT_CLASS');
  expect(transcriptSource).not.toContain('max-w-4xl');
  expect(composerSource).not.toContain('max-w-4xl');
});

test('session layout preserves transcript height below the large breakpoint', () => {
  const routeSource = readFileSync(new URL('../../src/features/session/SessionRoute.tsx', import.meta.url), 'utf8');

  expect(routeSource).toContain('className="flex min-h-0 flex-1 overflow-hidden"');
  expect(routeSource).not.toContain('min-h-0 flex-1 overflow-hidden lg:flex');
});

test('archived session preview replaces the composer and focuses it after unarchive', () => {
  const composerSource = readFileSync(
    new URL('../../src/features/session/SessionComposerRegion.tsx', import.meta.url),
    'utf8'
  );
  const routeModelSource = readFileSync(
    new URL('../../src/features/session/use-session-route-model.ts', import.meta.url),
    'utf8'
  );
  const shellRouteSource = readFileSync(
    new URL('../../src/features/shell/page-shell/ShellRouteProvider.tsx', import.meta.url),
    'utf8'
  );

  expect(composerSource).toContain('if (identity.isArchived)');
  expect(composerSource).toContain("t('web.sidebar.unarchiveSession')");
  expect(composerSource).toContain('items-center justify-center');
  expect(composerSource).toContain('textareaRef={editorRef}');
  expect(composerSource).toContain('editorRef.current?.focus()');
  expect(routeModelSource).toContain('updateSession({ id: currentId, archived: false }).unwrap()');
  expect(routeModelSource).toContain('onSessionUnarchived();');
  expect(shellRouteSource).toContain('onOpenProjectSession: handleOpenProjectSession');
  expect(shellRouteSource).toContain('onOpenSession: handleOpenSession');
});

test('a deleted archived preview replaces the conversation until undo restores it', () => {
  const routeSource = readFileSync(new URL('../../src/features/session/SessionRoute.tsx', import.meta.url), 'utf8');
  const routeModelSource = readFileSync(
    new URL('../../src/features/session/use-session-route-model.ts', import.meta.url),
    'utf8'
  );
  const shellRouteSource = readFileSync(
    new URL('../../src/features/shell/page-shell/ShellRouteProvider.tsx', import.meta.url),
    'utf8'
  );
  const enLocale = readFileSync(new URL('../../../../packages/i18n/src/locales/en/web.json', import.meta.url), 'utf8');
  const zhLocale = readFileSync(new URL('../../../../packages/i18n/src/locales/zh/web.json', import.meta.url), 'utf8');

  expect(routeSource).toContain('if (model.identity.isDeleted)');
  expect(routeSource).toContain("t('web.sidebar.sessionDeleted')");
  expect(routeModelSource).toContain('isDeleted: isCurrentSessionDeleted');
  expect(shellRouteSource).toContain('preserveMissingSessionRoute: isCurrentArchivedSessionDeleted');
  expect(enLocale).toContain('"web.sidebar.sessionDeleted": "This session has been deleted"');
  expect(zhLocale).toContain('"web.sidebar.sessionDeleted": "当前 session 已删除"');
});

test('session header reserves space for collapsed sidebar chrome', () => {
  const headerSource = readFileSync(new URL('../../src/features/session/SessionHeader.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');
  const enLocale = readFileSync(new URL('../../../../packages/i18n/src/locales/en/web.json', import.meta.url), 'utf8');
  const zhLocale = readFileSync(new URL('../../../../packages/i18n/src/locales/zh/web.json', import.meta.url), 'utf8');
  const primaryHeaderIndex = headerSource.indexOf('<div className="panel-shell-header');

  expect(primaryHeaderIndex).toBeGreaterThan(-1);
  expect(headerSource).not.toContain('SessionLineage');
  expect(headerSource.match(/\[\.app-main-sidebar-collapsed_&\]:!pl-\[8\.5rem\]/g) ?? []).toHaveLength(1);
  expect(headerSource).toContain('h-[52px]');
  expect(styles).toMatch(
    /@media\s*\(max-width:\s*767px\)\s*{[^}]*\.panel-shell-header\s*{[^}]*padding-left:\s*8\.5rem;/s
  );
  expect(styles).not.toContain('padding-left: 8.5rem !important');
  expect(headerSource).toContain('className="flex min-w-0 flex-1 flex-col"');
  expect(headerSource).toContain('className="flex shrink-0 items-center gap-1.5"');
  expect(headerSource).toContain('state.transcriptRenderMode');
  expect(headerSource).toContain("renderMode === 'summary'");
  expect(headerSource).toContain("t('web.chat.viewModeSummaryLabel')");
  expect(headerSource).toContain("t('web.chat.viewModeDetailLabel')");
  expect(headerSource).not.toContain("inspector.renderMode === 'compact'");
  expect(enLocale).toContain('"web.chat.viewModeSummaryLabel": "Summary"');
  expect(enLocale).toContain('"web.chat.viewModeDetailLabel": "Detail"');
  expect(zhLocale).toContain('"web.chat.viewModeSummaryLabel": "摘要"');
  expect(zhLocale).toContain('"web.chat.viewModeDetailLabel": "详情"');
  expect(headerSource).not.toContain('web.inspector.sessionRuntime');
  expect(headerSource).toContain('web.chat.draftCreateFailed');
  expect(enLocale).not.toContain('web.inspector.sessionRuntime');
  expect(zhLocale).not.toContain('web.inspector.sessionRuntime');
});

test('compact transcript process has no frame or internal padding', () => {
  const transcriptSource = readFileSync(
    new URL('../../src/features/session/SessionTranscript.tsx', import.meta.url),
    'utf8'
  );

  expect(transcriptSource).toContain('<details');
  expect(transcriptSource).toContain('onToggle={(event) => setExpanded(event.currentTarget.open)}');
  expect(transcriptSource).toContain('open={expanded}');
  expect(transcriptSource).toContain(
    '<summary className="flex w-full cursor-pointer list-none items-center gap-1 border-b py-2 [&::-webkit-details-marker]:hidden">'
  );
  expect(transcriptSource).toContain('<MorphChevron');
  expect(transcriptSource).toContain('className="size-3.5"');
  expect(transcriptSource).toContain('expanded={expanded}');
  expect(transcriptSource).not.toContain('group-open:rotate-180');
  expect(transcriptSource).toContain('<div className="mt-4 grid w-full gap-5">');
  expect(transcriptSource).not.toContain('rounded-lg border bg-card');
  expect(transcriptSource).not.toContain('border-t px-4 py-4');
  expect(transcriptSource).not.toContain('marker:text-muted-foreground');
});

test('branch source boundary toggles copied history without navigating', () => {
  const transcriptSource = readFileSync(
    new URL('../../src/features/session/SessionTranscript.tsx', import.meta.url),
    'utf8'
  );
  const routeModelSource = readFileSync(
    new URL('../../src/features/session/use-session-route-model.ts', import.meta.url),
    'utf8'
  );

  expect(transcriptSource).toContain('branchSnapshotItems');
  expect(transcriptSource).toContain('expanded={branchHistoryExpanded}');
  expect(transcriptSource).not.toContain('ArrowRight01Icon');
  expect(transcriptSource).not.toContain('onOpenBranchSource');
  expect(routeModelSource).not.toContain('branchSourceHref');
  expect(routeModelSource).not.toContain('onOpenBranchSource');
});
test('session transcript shows loading before an empty-state placeholder', () => {
  expect(sessionTranscriptHeaderState(true, false, 0)).toBe('loading');
  expect(sessionTranscriptHeaderState(true, true, 0)).toBe('skeleton');
  expect(sessionTranscriptHeaderState(false, false, 0)).toBe('empty');
  expect(sessionTranscriptHeaderState(false, true, 1)).toBe('content');
});
