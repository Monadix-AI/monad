# Behavior-Driven Test Assertions Design

**Goal:** Make tests prove observable behavior or exact public contracts instead of proving that implementation details, entities, source fragments, or truthy values exist.

## Scope

Audit the repository's Bun and Playwright test files. Preserve assertions where absence is itself the public contract, including redaction, deletion, optional response fields, pagination termination, and explicit not-found behavior.

## Classification

An assertion is behavior-driven when it observes a return value, state transition, emitted event, transport response, user interaction result, side effect, error, or exact serialized contract caused by an action.

An assertion is implementation-driven when its only claim is that a symbol, registry entry, DOM node, source fragment, mock, or truthy value exists. Replace it by invoking the discovered capability, observing the resulting user-visible state, or comparing the complete relevant contract.

Assertions over source text are allowed only when source text is the product under test, such as a generated artifact, release bundle, migration, or compiler transformation. They are not allowed as substitutes for exercising application behavior.

## Enforcement

Add a repository test-quality audit that identifies inherently weak positive-existence matchers and source-inspection tests for semantic review. The audit must avoid banning legitimate absence contracts mechanically. The repository testing guide will record the same boundary so future TDD starts from observable behavior.

## Verification

Run the audit against all test files, run every directly changed test through `scripts/bun-test.ts ... --only-failures`, then run the repository lint, typecheck, and test gates in one failure-collection pass. Preserve and report unrelated pre-existing working-tree changes separately.
