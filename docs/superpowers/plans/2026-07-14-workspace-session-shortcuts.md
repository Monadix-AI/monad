# Workspace Session Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Mod+N`, `Mod+I`, and workspace `Mod+1` through `Mod+9` navigation that follows the visible sidebar session order.

**Architecture:** Keep keyboard matching in `use-sidebar-shortcuts.ts`. Add a small DOM projection that finds eligible session rows in rendered order, ignoring rows beneath inert collapsed containers; use the same projection for activation and numbered badges. Mark only session links through `WorkspaceTreeItem`, while Studio retains its existing action array.

**Tech Stack:** React 19, TypeScript, TanStack Hotkeys, Bun test, Biome

## Global Constraints

- Work directly on `main`, as explicitly requested.
- `Mod+N` opens New chat and `Mod+I` opens Inbox.
- Workspace numbers only visible sessions; pinned, project, and chat sessions share screen order.
- Collapsed and preview-hidden sessions do not receive shortcuts.
- Studio numeric navigation must not change.
- Use Bun commands only.

---

### Task 1: Visible session projection and shortcut dispatch

**Files:**
- Modify: `apps/web/test/unit/sidebar-hotkeys.test.ts`
- Modify: `apps/web/src/hooks/use-sidebar-shortcuts.ts`

**Interfaces:**
- Produces: `visibleSidebarSessionRows(root: Pick<Document, 'querySelectorAll'>): HTMLElement[]`
- Produces: `activateVisibleSidebarSession(index: number, root?: Pick<Document, 'querySelectorAll'>): boolean`
- Consumes: session links marked with `data-sidebar-session-row="true"`

- [ ] **Step 1: Write failing tests for visible order and global actions**

Add fake session rows with `closest('[inert]')`, `click()`, and `dataset`, then assert that the projection preserves mixed DOM order, excludes inert descendants, and activates only an existing index. Add handler tests asserting `Mod+N` and `Mod+I` call their dedicated actions and prevent defaults.

```ts
test('visible session shortcuts preserve DOM order and skip inert rows', () => {
  const rows = [fakeRow('pinned'), fakeRow('collapsed', true), fakeRow('project'), fakeRow('chat')];
  expect(visibleSidebarSessionRows(fakeRoot(rows)).map((row) => row.dataset.testId)).toEqual([
    'pinned',
    'project',
    'chat'
  ]);
});

test('new chat and inbox shortcuts run dedicated actions', () => {
  const calls: string[] = [];
  const handler = createSidebarShortcutHandler({
    applePlatform: true,
    inboxShortcutAction: () => calls.push('inbox'),
    newChatShortcutAction: () => calls.push('new-chat'),
    showSettings: false,
    sidebarShortcutActions: [],
    toggleSettings: () => undefined
  });
  handler(shortcutEvent({ key: 'n', code: 'KeyN', metaKey: true }).event);
  handler(shortcutEvent({ key: 'i', code: 'KeyI', metaKey: true }).event);
  expect(calls).toEqual(['new-chat', 'inbox']);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun scripts/bun-test.ts apps/web/test/unit/sidebar-hotkeys.test.ts --only-failures`

Expected: FAIL because the visible-session helpers, hotkey constants, and dedicated action arguments do not exist.

- [ ] **Step 3: Implement minimal projection and shortcut matching**

Add `newChatHotkey = 'Mod+N'`, `inboxHotkey = 'Mod+I'`, optional dedicated callbacks, and helpers equivalent to:

```ts
const sidebarSessionSelector = '[data-sidebar-session-row="true"]';

export function visibleSidebarSessionRows(root: Pick<Document, 'querySelectorAll'>): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(sidebarSessionSelector)).filter((row) => !row.closest('[inert]'));
}

export function activateVisibleSidebarSession(
  index: number,
  root: Pick<Document, 'querySelectorAll'> = document
): boolean {
  const row = visibleSidebarSessionRows(root)[index];
  if (!row) return false;
  row.click();
  return true;
}
```

Match `Mod+N` and `Mod+I` after the settings gate and before Monad Agent/numeric handling; prevent defaults and reveal the sidebar before invoking the action.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun scripts/bun-test.ts apps/web/test/unit/sidebar-hotkeys.test.ts --only-failures`

Expected: PASS with zero failures.

### Task 2: Mark session rows and move badges from projects to visible sessions

**Files:**
- Modify: `apps/web/src/features/shell/sidebar/workspace-tree-item.tsx`
- Modify: `apps/web/src/features/shell/sidebar/chat-session-list.tsx`
- Modify: `apps/web/src/features/shell/sidebar/workspace-project-rows.tsx`
- Modify: `apps/web/src/features/shell/sidebar/nav-item.tsx`
- Modify: `apps/web/src/hooks/use-sidebar-shortcuts.ts`
- Modify: `apps/web/test/unit/sidebar-hotkeys.test.ts`

**Interfaces:**
- Consumes: `visibleSidebarSessionRows(...)` from Task 1
- Produces: `WorkspaceTreeItem` boolean prop `sidebarSession`
- Produces: `syncVisibleSidebarSessionShortcutBadges(modifierLabel, root?)`

- [ ] **Step 1: Write a failing badge synchronization test**

Assert that synchronization clears stale attributes, assigns `1` through `9` only to eligible rows, and stores the modifier label used by the badge CSS.

```ts
syncVisibleSidebarSessionShortcutBadges('⌘', fakeRoot(rows));
expect(rows[0].dataset.sidebarShortcut).toBe('1');
expect(rows[1].dataset.sidebarShortcut).toBeUndefined();
expect(rows[9].dataset.sidebarShortcut).toBe('9');
expect(rows[10].dataset.sidebarShortcut).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun scripts/bun-test.ts apps/web/test/unit/sidebar-hotkeys.test.ts --only-failures`

Expected: FAIL because badge synchronization is not implemented.

- [ ] **Step 3: Implement session row markers and badge synchronization**

Add `sidebarSession?: boolean` to `WorkspaceTreeItem` and place `data-sidebar-session-row={sidebarSession || undefined}` on the interactive link/button. Pass it from chat, project-session, and pinned-session rows, but not project headers. Remove the old project header `ShortcutBadge` overlay.

Synchronize the first nine visible rows when the modifier is held and whenever the sidebar DOM mutates. Store `data-sidebar-shortcut` and `data-sidebar-shortcut-modifier`; clear both when badges hide. Extend `SidebarActionVisibilityRules` with styling for the session-row pseudo-element so it visually matches the former badge.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun scripts/bun-test.ts apps/web/test/unit/sidebar-hotkeys.test.ts --only-failures`

Expected: PASS with zero failures.

### Task 3: Connect workspace actions while preserving Studio navigation

**Files:**
- Modify: `apps/web/src/features/shell/routing/navigation.ts`
- Modify: `apps/web/test/unit/sidebar-hotkeys.test.ts`

**Interfaces:**
- Consumes: `activateVisibleSidebarSession(index)` from Task 1
- Consumes: `handleNewMonadChat` and `openInbox` existing callbacks
- Preserves: Studio `sidebarShortcutActions` ordering

- [ ] **Step 1: Add a failing contract test for the nine workspace activators**

Export a small pure builder if needed and assert that workspace returns nine index-based activators while Studio continues to return its named section actions.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun scripts/bun-test.ts apps/web/test/unit/sidebar-hotkeys.test.ts --only-failures`

Expected: FAIL because workspace still maps numbers to projects.

- [ ] **Step 3: Wire the navigation callbacks**

In workspace mode, build nine callbacks that invoke `activateVisibleSidebarSession(index)`. In Studio mode, retain the existing section callback array. Pass `newChatShortcutAction: handleNewMonadChat` and `inboxShortcutAction: openInbox` into `useSidebarShortcuts`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun scripts/bun-test.ts apps/web/test/unit/sidebar-hotkeys.test.ts --only-failures`

Expected: PASS with zero failures.

Run: `bun run --cwd apps/web typecheck`

Expected: exit 0.

### Task 4: Final verification and implementation commit

**Files:**
- Verify all files listed above
- Include: `docs/superpowers/plans/2026-07-14-workspace-session-shortcuts.md`

- [ ] **Step 1: Run the complete web unit test directory**

Run: `bun scripts/bun-test.ts apps/web/test/unit --only-failures`

Expected: PASS with zero failures.

- [ ] **Step 2: Run repository checks for the touched surface**

Run: `bun biome check apps/web/src/hooks/use-sidebar-shortcuts.ts apps/web/src/features/shell/routing/navigation.ts apps/web/src/features/shell/sidebar/workspace-tree-item.tsx apps/web/src/features/shell/sidebar/chat-session-list.tsx apps/web/src/features/shell/sidebar/workspace-project-rows.tsx apps/web/src/features/shell/sidebar/nav-item.tsx apps/web/test/unit/sidebar-hotkeys.test.ts docs/superpowers/plans/2026-07-14-workspace-session-shortcuts.md`

Expected: exit 0 with no diagnostics.

Run: `git diff --check`

Expected: exit 0 with no output.

- [ ] **Step 3: Review the final diff against every spec requirement**

Confirm New chat, Inbox, visible-session ordering, collapsed exclusion, shared numbering, badge placement, and unchanged Studio navigation from the actual diff and test evidence.

- [ ] **Step 4: Commit the implementation on main**

```bash
git add docs/superpowers/plans/2026-07-14-workspace-session-shortcuts.md \
  apps/web/src/hooks/use-sidebar-shortcuts.ts \
  apps/web/src/features/shell/routing/navigation.ts \
  apps/web/src/features/shell/sidebar/workspace-tree-item.tsx \
  apps/web/src/features/shell/sidebar/chat-session-list.tsx \
  apps/web/src/features/shell/sidebar/workspace-project-rows.tsx \
  apps/web/src/features/shell/sidebar/nav-item.tsx \
  apps/web/test/unit/sidebar-hotkeys.test.ts
git commit -m "feat(web): navigate visible sessions with shortcuts"
```
