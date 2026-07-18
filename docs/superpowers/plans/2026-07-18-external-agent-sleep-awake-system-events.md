# External Agent Sleep and Awake System Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render external-agent idle lifecycle notices with configured member identity and concise sleep/awake copy, backed by one strict system-event contract.

**Architecture:** Define a protocol-owned `ExternalAgentSystemEvent` discriminated union, reuse its variants in daemon event payloads, and carry the typed event through `UISystemItem.event`. Resolve the event identity through the same project-member view used by member-join events and keep the existing `SystemMessageRow` renderer.

**Tech Stack:** TypeScript, Zod, React, Bun test, repository i18n catalogs.

## Global Constraints

- Event shape is `agentId`, `agentName`, `type`, and `payload`.
- `type` is the discriminant and must accept only its matching strict payload.
- `agentId` is the stable runtime/member ID; `agentName` is configured display name or falls back to `agentId`.
- English copy is exactly `fell asleep.` and `woke up.`.
- Chinese copy is exactly `睡着了。` and `醒来了。`.
- Reuse the member-join system-event identity and existing renderer.
- Legacy lifecycle system items without `event` remain renderable through the old ID-prefix fallback.
- Follow TDD and preserve unrelated concurrent WIP on `main`.

---

### Task 1: Define and emit strict typed lifecycle events

**Files:**
- Add: `packages/protocol/src/external-agent/external-agent-system-event.ts`
- Modify: `packages/protocol/src/external-agent/index.ts`
- Modify: `packages/protocol/src/event-table.ts`
- Modify: `packages/protocol/src/ui.ts`
- Modify: `apps/monad/src/services/external-agent/host/host-types.ts`
- Modify: `apps/monad/src/services/external-agent/host/index.ts`
- Modify: `apps/monad/src/services/external-agent/host/session-launcher.ts`
- Modify: `apps/monad/src/handlers/session/ui-projection-tool-events.ts`
- Test: protocol and daemon lifecycle suites

- [x] Add strict `idle_suspended` and `idle_resumed` schemas.
- [x] Combine them with `z.discriminatedUnion('type', ...)`.
- [x] Reuse the variant schemas as event-table payload schemas.
- [x] Replace `UISystemItem.actor` with optional `UISystemItem.event`.
- [x] Emit stable `agentId`, configured/fallback `agentName`, discriminant, and nested payload from the host.
- [x] Carry the typed event unchanged through daemon UI projection.
- [x] Keep localized action-only copy.
- [x] Add exact contract, mismatch-rejection, host fallback, and projection tests.
- [x] Review and fix forwarding so an absent configured name remains absent until the host applies `agentName === agentId`.

### Task 2: Render lifecycle events with member identity

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/projection.ts`
- Test: `packages/atoms/test/unit/workspace-project-messages.test.ts`

- [ ] Add failing suspend/resume tests for structured `UISystemItem.event`.
- [ ] Resolve `event.agentId` with the member-join identity helper.
- [ ] Prefer display-name map, member name, event name, then stable ID.
- [ ] Reuse avatar seed/style, product icon, and tag resolution.
- [ ] Produce `agentChip` while retaining exact action-only text.
- [ ] Cover missing metadata fallback.
- [ ] Retain legacy ID-prefix behavior only for event-less lifecycle items.
- [ ] Run focused atoms tests and review the task-only diff without committing pre-existing WIP.

### Task 3: Verify and hand off

- [ ] Run focused protocol, daemon, and atoms test scopes.
- [ ] Run applicable typechecks and formatting checks.
- [ ] Review the complete feature diff for contract duplication and weak assertions.
- [ ] Restore every temporarily isolated user WIP patch and report any unrelated baseline failures separately.
