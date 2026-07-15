# Interactions Zod Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interactions controller's TypeBox-backed route schemas with reusable Zod schemas owned by `@monad/protocol`.

**Architecture:** The protocol package owns HTTP parameter and body validation. The Elysia controller consumes those Zod schemas through Standard Schema support and contains no schema definitions of its own.

**Tech Stack:** Bun, TypeScript, Zod 4, Elysia 1.4, Bun test

## Global Constraints

- `@monad/protocol` remains the single source of truth for interaction contracts.
- Monad application code must not use Elysia's `t` schema builder.
- No Monad workspace declares `@sinclair/typebox` directly; it may remain resolved as Elysia's peer.

---

### Task 1: Add protocol-owned HTTP schemas

**Files:**
- Modify: `packages/protocol/src/interaction.ts`
- Test: `packages/protocol/test/interaction.test.ts`

**Interfaces:**
- Consumes: `interactionPresenterCapabilitiesSchema`
- Produces: `interactionIdParamsSchema`, `interactionPresenterParamsSchema`, `interactionClaimBodySchema`, `interactionLeaseBodySchema`, `interactionSubmitBodySchema`, `interactionCancelBodySchema`

- [x] Write protocol tests that parse valid inputs and reject empty identifiers, empty lease tokens, unsupported cancellation reasons, and extra properties.
- [x] Run `bun scripts/bun-test.ts packages/protocol/test/interaction.test.ts --only-failures` and verify the new exports are missing.
- [x] Implement the schemas in `packages/protocol/src/interaction.ts`, extracting a shared `interactionCancellationReasonSchema` for result and request contracts.
- [x] Rerun the protocol test and verify it passes.

### Task 2: Consume Zod schemas from the Elysia controller

**Files:**
- Modify: `apps/monad/src/transports/http/interactions.ts`

**Interfaces:**
- Consumes: the six schemas produced by Task 1
- Produces: the same interactions HTTP routes with Zod-backed validation and inference

- [x] Replace the Elysia `t` import and every local TypeBox schema with imports from `@monad/protocol`.
- [x] Run the focused protocol test and `bun run --cwd apps/monad build`.
- [x] Run `bun run knip` and the repository's read-only quality gate.
