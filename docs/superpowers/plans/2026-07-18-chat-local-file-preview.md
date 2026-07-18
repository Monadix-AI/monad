# Chat Local File Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `monad:file` Markdown links and message attachments as file-aware Chat Experience controls that open a syntax-highlighted, line-numbered right-rail preview, while fixing inline-link baseline alignment.

**Architecture:** Keep the daemon's structured attachment as the only readable file capability. Share file icon inference in `@monad/ui`, resolve marked Markdown destinations against same-message attachments in a pure Chat Experience helper, and store one session-scoped rail detail selection that is either a file preview or an agent observation. Both Markdown links and attachment cards call the same preview action.

**Tech Stack:** React 19, TypeScript, Zustand, RTK Query attachment endpoints, Shiki through `@monad/ui` `CodeBlock`, Bun tests, Biome.

## Global Constraints

- Only Markdown anchors whose title is exactly `monad:file` are local-file references.
- File content is fetched only through `/v1/attachments/:id`; never read an arbitrary Markdown path.
- Ordinary HTTP(S) links retain favicon rendering and external navigation.
- The feature is limited to the built-in `chat-room` workspace experience.
- Attachment cards use exactly two visual rows: identity, then metadata and actions.
- Text/code previews include line numbers, syntax highlighting, truncation state, and optional `#L<number>` focus.
- Inline web and file links share a baseline-aligned line-box contract with surrounding text.

---

### Task 1: Shared File Icon and Inline Link Alignment

**Files:**
- Create: `packages/ui/src/components/FileIcon.tsx`
- Modify: `packages/ui/src/components/FaviconLink.tsx`
- Modify: `apps/web/src/lib/file-icons.tsx`
- Test: `packages/ui/test/unit/file-icon.test.tsx`
- Test: `packages/ui/test/unit/favicon-link.test.tsx`

**Interfaces:**
- Produces: `FileIcon({ fileName, contentType?, preview?, className? })`
- Produces: shared `inline-file-link`/`inline-web-link` baseline classes used by later Chat Experience anchors.

- [ ] **Step 1: Write failing shared-icon and alignment tests**

```tsx
test('FileIcon selects code and image icons from extension and MIME', () => {
  expect(renderToStaticMarkup(<FileIcon fileName="index.ts" />)).toContain('data-file-icon="code"');
  expect(renderToStaticMarkup(<FileIcon contentType="image/png" fileName="asset.bin" />)).toContain(
    'data-file-icon="image"'
  );
});

test('FaviconLink exposes the inline baseline alignment contract', () => {
  const markup = renderToStaticMarkup(<FaviconLink href="https://example.com">Example</FaviconLink>);
  expect(markup).toContain('data-inline-link="web"');
  expect(markup).toContain('align-baseline');
  expect(markup).toContain('leading-[inherit]');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test packages/ui/test/unit/file-icon.test.tsx packages/ui/test/unit/favicon-link.test.tsx`

Expected: FAIL because `FileIcon` and the baseline data contract do not exist.

- [ ] **Step 3: Move icon inference into `@monad/ui` and align favicon links**

Create `packages/ui/src/components/FileIcon.tsx` from the existing `apps/web/src/lib/file-icons.tsx` mapping, adding a stable semantic marker:

```tsx
export type FilePreviewKind = 'image' | 'text' | 'unsupported';

export function FileIcon({ className, contentType, fileName, preview }: FileIconProps) {
  const { icon, kind } = getFileIcon({ contentType, fileName, preview });
  return <HugeiconsIcon aria-hidden="true" className={className} data-file-icon={kind} icon={icon} />;
}
```

Update `FaviconLink`:

```tsx
<a
  {...props}
  className={cn(
    'inline-flex max-w-full cursor-pointer items-baseline gap-1 align-baseline leading-[inherit]',
    className
  )}
  data-inline-link="web"
  data-preserve-cursor="true"
  href={href}
  rel="noopener noreferrer"
  target="_blank"
>
```

Make `apps/web/src/lib/file-icons.tsx` re-export the shared component and types so existing imports remain valid:

```ts
export { FileIcon, type FilePreviewKind } from '@monad/ui/components/FileIcon';
```

- [ ] **Step 4: Run focused tests and package typechecks**

Run: `bun test packages/ui/test/unit/file-icon.test.tsx packages/ui/test/unit/favicon-link.test.tsx && bun run --cwd packages/ui typecheck && bun run --cwd apps/web typecheck`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/FileIcon.tsx packages/ui/src/components/FaviconLink.tsx apps/web/src/lib/file-icons.tsx packages/ui/test/unit/file-icon.test.tsx packages/ui/test/unit/favicon-link.test.tsx
git commit -m "feat(ui): share file icons and align inline links"
```

---

### Task 2: Local File Reference Matching and Markdown Rendering

**Files:**
- Create: `packages/atoms/src/workspace-experiences/chat-room/utils/local-file-reference.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/message-row.tsx`
- Test: `packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts`

**Interfaces:**
- Consumes: `MessageAttachmentRef` and `FileIcon` from Task 1.
- Produces: `resolveLocalFileReference(href, attachments): { attachment?: MessageAttachment; line?: number; path: string }`.
- Produces: `messageMarkdownComponents({ attachments, onOpenAttachment })` renderer factory.

- [ ] **Step 1: Write failing path-resolution and rendering tests**

```tsx
test('resolves marked absolute and file URL targets to same-message attachments', () => {
  expect(resolveLocalFileReference('/workspace/report.ts#L12', [attachment])).toEqual({
    attachment,
    line: 12,
    path: '/workspace/report.ts'
  });
  expect(resolveLocalFileReference('file:///workspace/report.ts', [attachment])?.attachment).toEqual(attachment);
});

test('monad:file renders a non-navigating file control', () => {
  const Anchor = messageMarkdownComponents({ attachments: [attachment], onOpenAttachment: () => {} }).a;
  const markup = renderToStaticMarkup(
    createElement(Anchor!, { href: '/workspace/report.ts#L12', title: 'monad:file' }, 'report.ts')
  );
  expect(markup).toContain('data-inline-link="file"');
  expect(markup).toContain('data-file-icon="code"');
  expect(markup).not.toContain('href=');
});
```

- [ ] **Step 2: Run the transcript test and verify RED**

Run: `bun test packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts`

Expected: FAIL because the resolver and renderer factory do not exist.

- [ ] **Step 3: Implement safe normalization and the renderer factory**

```ts
export function resolveLocalFileReference(
  href: string,
  attachments: readonly MessageAttachment[]
): LocalFileReference {
  const [target, fragment = ''] = href.split('#', 2);
  const path = normalizeLocalFileTarget(target ?? '');
  const lineMatch = /^L([1-9]\d*)$/.exec(fragment);
  return {
    attachment: attachments.find((item) => normalizeLocalFileTarget(item.path) === path),
    line: lineMatch ? Number(lineMatch[1]) : undefined,
    path
  };
}
```

Render `title="monad:file"` as a baseline-aligned button. Disable unmatched references and never retain `href`; preserve mention and favicon branches. Pass each message's attachments and preview callback through `MessageBubbleContent` to the Markdown renderer.

- [ ] **Step 4: Run focused tests and atoms typecheck**

Run: `bun test packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts && bun run --cwd packages/atoms typecheck`

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/atoms/src/workspace-experiences/chat-room/utils/local-file-reference.ts packages/atoms/src/workspace-experiences/chat-room/components/message-row.tsx packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts
git commit -m "feat(chat): recognize local file links"
```

---

### Task 3: Session-Scoped File Preview State

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/store.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/message-list.tsx`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/message-row.tsx`
- Test: `packages/atoms/test/unit/workspace-project-rail.test.ts`

**Interfaces:**
- Produces: `ChatRoomFilePreview { attachment: MessageAttachmentRef; line?: number }`.
- Produces: `filePreviewBySession`, `openFilePreview(uiKey, preview)`, and `closeFilePreview(uiKey)`.
- Consumes: `resolveLocalFileReference` from Task 2.

- [ ] **Step 1: Write failing rail-state tests**

```ts
test('file preview is session scoped and replaces observation detail', () => {
  const store = useChatRoomExperienceStore.getState();
  store.observeProjectAgent(firstKey, 'project-1', { agentId: 'agent-1', agentName: 'Agent' });
  store.openFilePreview(firstKey, { attachment, line: 12 });
  expect(useChatRoomExperienceStore.getState().railObservationBySession[firstKey]).toBeUndefined();
  expect(useChatRoomExperienceStore.getState().filePreviewBySession[firstKey]).toEqual({ attachment, line: 12 });
  expect(useChatRoomExperienceStore.getState().filePreviewBySession[secondKey]).toBeUndefined();
});
```

- [ ] **Step 2: Run the rail test and verify RED**

Run: `bun test packages/atoms/test/unit/workspace-project-rail.test.ts`

Expected: FAIL because file preview state/actions do not exist.

- [ ] **Step 3: Implement mutually exclusive rail state and wire message callbacks**

```ts
openFilePreview: (uiKey, preview) =>
  set((state) => {
    const observations = { ...state.railObservationBySession };
    delete observations[uiKey];
    return {
      railObservationBySession: observations,
      filePreviewBySession: { ...state.filePreviewBySession, [uiKey]: preview }
    };
  })
```

Make `followExternalAgentSession` and `observeProjectAgent` delete the same session's file preview. In `ChatMessageList`, derive `uiKey` from `room.projectId` and `room.activeSessionId`, then pass `openFilePreview` to both `MessageRow` and its attachment component.

- [ ] **Step 4: Run focused tests and atoms typecheck**

Run: `bun test packages/atoms/test/unit/workspace-project-rail.test.ts packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts && bun run --cwd packages/atoms typecheck`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/atoms/src/workspace-experiences/chat-room/store.ts packages/atoms/src/workspace-experiences/chat-room/components/message-list.tsx packages/atoms/src/workspace-experiences/chat-room/components/message-row.tsx packages/atoms/test/unit/workspace-project-rail.test.ts
git commit -m "feat(chat): track file previews in the project rail"
```

---

### Task 4: Right-Rail File Preview Panel

**Files:**
- Create: `packages/atoms/src/workspace-experiences/chat-room/components/file-preview-panel.tsx`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx`
- Modify: `packages/i18n/src/locales/en/web.json`
- Modify: `packages/i18n/src/locales/zh/web.json`
- Test: `packages/atoms/test/unit/workspace-file-preview-panel.test.tsx`

**Interfaces:**
- Consumes: `ChatRoomFilePreview`, attachment query/download hooks, `FileIcon`, and `CodeBlock`.
- Produces: `FilePreviewPanel({ preview, onBack })`.
- Produces: `inferPreviewLanguage(path): BundledLanguage` and `filePreviewLines(text)` pure helpers.

- [ ] **Step 1: Write failing preview-model and panel tests**

```tsx
test('file preview renders numbered source and truncation status', () => {
  const markup = renderToStaticMarkup(
    <FilePreviewContent attachment={attachment} content="const answer = 42;" line={1} truncated />
  );
  expect(markup).toContain('data-preview-line="1"');
  expect(markup).toContain('data-focus-line="true"');
  expect(markup).toContain('data-language="typescript"');
  expect(markup).toContain('Preview truncated');
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `bun test packages/atoms/test/unit/workspace-file-preview-panel.test.tsx`

Expected: FAIL because the panel and helpers do not exist.

- [ ] **Step 3: Implement the panel and rail selection**

Use the existing query and download hooks. Render loading/error/unsupported states in the panel body. For loaded text, render `CodeBlock` with `showLineNumbers`, `data-language`, and a line-focus overlay/anchor keyed by `data-preview-line`; use an effect to scroll `[data-preview-line="${line}"]` into view. Display a distinct translated truncation notice.

In `AgentTasksRail`, select the session preview before observation detail:

```tsx
{filePreview ? (
  <FilePreviewPanel preview={filePreview} onBack={() => closeFilePreview(uiKey)} />
) : observation ? (
  <ExternalAgentObservationPanel ... />
) : (
  <AgentGrid ... />
)}
```

- [ ] **Step 4: Run focused tests, i18n check, and atoms typecheck**

Run: `bun test packages/atoms/test/unit/workspace-file-preview-panel.test.tsx packages/atoms/test/unit/workspace-project-rail.test.ts && bun run i18n:check && bun run --cwd packages/atoms typecheck`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/atoms/src/workspace-experiences/chat-room/components/file-preview-panel.tsx packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx packages/i18n/src/locales/en/web.json packages/i18n/src/locales/zh/web.json packages/atoms/test/unit/workspace-file-preview-panel.test.tsx
git commit -m "feat(chat): preview message files in the right rail"
```

---

### Task 5: Two-Row Attachment Card and Unified Preview Action

**Files:**
- Modify: `packages/ui/src/components/AttachmentCard.tsx`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/attachment-chip.tsx`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/message-row.tsx`
- Test: `packages/ui/test/unit/chat-cards.test.tsx`

**Interfaces:**
- Consumes: `FileIcon` and `openFilePreview` from earlier tasks.
- Produces: `AttachmentCard` with `name`, `path?`, `sizeLabel`, `previewable`, `onPreview`, and `onDownload` props; no inline expanded preview state.

- [ ] **Step 1: Rewrite the attachment card test to require two rows**

```tsx
expect(markup).toContain('data-attachment-row="identity"');
expect(markup).toContain('data-attachment-row="actions"');
expect(markup).toContain('data-file-icon="text"');
expect(markup).not.toContain('first line\nsecond line');
```

- [ ] **Step 2: Run the card test and verify RED**

Run: `bun test packages/ui/test/unit/chat-cards.test.tsx`

Expected: FAIL because the existing card is single-row and contains inline preview output.

- [ ] **Step 3: Implement the two-row card and remove attachment-local preview fetching**

```tsx
<div className="mt-2 rounded-lg border border-border bg-card px-2.5 py-2" data-attachment-card="true">
  <div className="flex min-w-0 items-center gap-2" data-attachment-row="identity">
    <FileIcon className="size-4 shrink-0" contentType={mime} fileName={name} />
    <span className="min-w-0 truncate font-semibold" title={path}>{name}</span>
  </div>
  <div className="mt-1.5 flex items-center gap-2 pl-6" data-attachment-row="actions">
    <span className="font-mono text-[11px] text-muted-foreground">{sizeLabel}</span>
    {previewable ? <button onClick={onPreview}>...</button> : null}
    <button onClick={onDownload}>...</button>
  </div>
</div>
```

`AttachmentChip` keeps only download/error state and delegates Preview to the callback supplied by `MessageRow`; it no longer fetches or expands content inside the transcript.

- [ ] **Step 4: Run focused tests and package typechecks**

Run: `bun test packages/ui/test/unit/chat-cards.test.tsx packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts packages/atoms/test/unit/workspace-file-preview-panel.test.tsx && bun run --cwd packages/ui typecheck && bun run --cwd packages/atoms typecheck`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/AttachmentCard.tsx packages/atoms/src/workspace-experiences/chat-room/components/attachment-chip.tsx packages/atoms/src/workspace-experiences/chat-room/components/message-row.tsx packages/ui/test/unit/chat-cards.test.tsx
git commit -m "feat(chat): use two-row message attachments"
```

---

### Task 6: Full Verification and Local Session QA

**Files:**
- Modify only if verification exposes a defect in the files listed above.

**Interfaces:**
- Verifies the complete feature contract; produces no new API.

- [ ] **Step 1: Run focused regression suites**

Run:

```bash
bun test \
  packages/ui/test/unit/file-icon.test.tsx \
  packages/ui/test/unit/favicon-link.test.tsx \
  packages/ui/test/unit/chat-cards.test.tsx \
  packages/atoms/test/unit/workspace-chat-transcript-markdown.test.ts \
  packages/atoms/test/unit/workspace-project-rail.test.ts \
  packages/atoms/test/unit/workspace-file-preview-panel.test.tsx
```

Expected: 0 failures.

- [ ] **Step 2: Run changed-package and repository checks**

Run:

```bash
bun run --cwd packages/ui typecheck
bun run --cwd packages/atoms typecheck
bun run --cwd apps/web typecheck
bun run i18n:check
bun run lint:check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Verify the supplied local workspace session**

Open `https://127.0.0.1:52749/workspace/prj_Hp5QxIAdpCg8/ses_6uuEW8Gf6S8D`, reload after HMR settles, and verify:

- A marked local-file link has a file icon and aligns with adjacent text.
- Clicking it opens the right rail with line numbers and syntax highlighting.
- A message attachment has two rows and its Preview action opens the same panel.
- Download remains available.

If the self-signed certificate prevents browser automation, record that exact limitation and do not claim live UI verification.

- [ ] **Step 4: Inspect final diff and commit any verification-only fix**

Run: `git status --short && git diff --check && git log --oneline -8`

Expected: only intended feature files are changed; ideally the worktree is clean after task commits.
