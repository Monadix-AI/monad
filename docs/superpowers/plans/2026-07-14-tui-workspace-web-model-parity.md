# TUI Workspace Web-Model Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TUI Web-aligned Chat Agent selection and native Workplace Project management while preventing long messages from shrinking the speaker column.

**Architecture:** Pure workspace models build existing API requests, labels, confirmation transitions, and member-template updates. Ink browsers consume those models and existing client-rtk hooks; advanced Project settings deep-link to Web.

**Tech Stack:** Ink 7, React 19, RTK Query, `@monad/protocol`, `@monad/home`, Bun test, TypeScript.

## Global Constraints

- Do not add daemon endpoints or change protocol schemas.
- Chat may bind one optional Monad Agent; omitted means daemon default.
- Project sessions inherit Project member templates and never receive `agentId` on creation.
- Experience extensions remain Web-only.
- Destructive Project/session actions require two-step confirmation.
- Preserve unrelated dirty worktree changes.

---

### Task 1: Stable message speaker column

**Files:**
- Create: `apps/tui/src/components/message-layout.ts`
- Create: `apps/tui/test/unit/message-layout.test.ts`
- Modify: `apps/tui/src/components/Message.tsx`

**Interfaces:**
- Produces: `MESSAGE_SPEAKER_WIDTH` and `messageContentWidth(totalWidth)`.

- [ ] Write a failing test asserting a constant reserved speaker width and positive remaining content width.
- [ ] Run `bun test apps/tui/test/unit/message-layout.test.ts`; expect missing-module failure.
- [ ] Implement the constants and split `MessageRow` into fixed `flexShrink={0}` speaker/caret and `flexBasis={0}` content boxes; reuse the offset for tools.
- [ ] Re-run the focused test; expect zero failures.

### Task 2: Chat Agent selection and management model

**Files:**
- Create: `apps/tui/src/shell/workspace-model.ts`
- Create: `apps/tui/test/unit/workspace-model.test.ts`
- Modify: `apps/tui/src/components/SessionBrowser.tsx`

**Interfaces:**
- Produces: `chatCreateRequest(title, agentId)`, `chatAgentLabel(agentIds, agents)`, and `confirmDestructive(previousId, selectedId)`.

- [ ] Write failing tests proving Default Agent omits `agentId`, an explicit Agent includes it, stale IDs render unavailable, and confirmation requires the same selected ID twice.
- [ ] Run `bun test apps/tui/test/unit/workspace-model.test.ts`; expect missing exports.
- [ ] Implement the pure model.
- [ ] Extend `SessionBrowser` with Agent list/default option, create flow, bound-Agent metadata, rename, and two-step delete using existing session hooks.
- [ ] Re-run focused tests; expect zero failures.

### Task 3: Workplace Project CRUD and session management

**Files:**
- Modify: `apps/tui/src/shell/workspace-model.ts`
- Modify: `apps/tui/test/unit/workspace-model.test.ts`
- Rewrite: `apps/tui/src/components/ProjectBrowser.tsx`
- Modify: `apps/tui/src/components/Layout.tsx`

**Interfaces:**
- Produces: `projectCreateRequest(name, cwd)`, `projectUpdateRequest(field, value)`, and `projectSessionCreateRequest(title)`; the session request type has no `agentId` property.

- [ ] Add failing tests for blank-name rejection, cwd trimming/omission, cwd clear, archive toggling, and project-session request shape.
- [ ] Run the focused model test; expect failures for absent functions.
- [ ] Implement request builders.
- [ ] Add Project list/detail modes for create, rename, cwd, archive/unarchive, two-step delete, and session create/open/rename/two-step delete.
- [ ] Pass `baseUrl` into `ProjectBrowser` for `/workspace/:id/settings` deep links.
- [ ] Re-run focused tests; expect zero failures.

### Task 4: Project member templates

**Files:**
- Modify: `apps/tui/src/shell/workspace-model.ts`
- Modify: `apps/tui/test/unit/workspace-model.test.ts`
- Modify: `apps/tui/src/components/ProjectBrowser.tsx`

**Interfaces:**
- Produces: `addProjectMemberTemplate(existing, candidate)` and `removeProjectMemberTemplate(existing, id)` using shared protocol helpers.

- [ ] Add failing tests for Monad/ACP duplicate rejection, multiple External Agent instances, removal, and preservation of existing advanced settings.
- [ ] Run the focused model test; expect failures for missing member helpers.
- [ ] Implement member helpers with shared IDs/default settings/display-name utilities.
- [ ] Query Monad/ACP/External Agent candidates in Project detail; support list/add/remove and Web settings deep link.
- [ ] Re-run focused tests; expect zero failures.

### Task 5: Verification

**Files:**
- Verify all Task 1–4 paths plus existing TUI tests.

**Interfaces:**
- Produces: fresh regression, type, formatting, and diff evidence.

- [ ] Run `bun run --cwd apps/tui test:unit:loud`; expect zero failures.
- [ ] Run `bun run --cwd apps/tui typecheck`; expect exit 0.
- [ ] Run `bunx biome check apps/tui/src apps/tui/test/unit`; expect exit 0.
- [ ] Run `git diff --check` and inspect the focused diff; expect no protocol/daemon/client-rtk changes.
