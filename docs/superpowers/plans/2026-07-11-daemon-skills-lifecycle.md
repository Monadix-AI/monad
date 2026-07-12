# Daemon Skills Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move skill discovery under capabilities and expose it as a reloadable lifecycle module downstream of atoms.

**Architecture:** Existing discovery and live array behavior moves to `capabilities/skills/service.ts`, depending only on a narrow watcher registrar. `capabilities/skills/lifecycle.ts` owns the current config snapshot, computes effective skill state lazily, and reloads the stable subsystem in place on config changes.

**Tech Stack:** Bun 1.3, TypeScript, RuntimeKernel, existing SkillRegistry, `bun:test`.

## Global Constraints

- Use Bun only and follow TDD.
- Module ID is `capabilities.skills`, required, and requires `atoms`.
- Preserve stable loaded/list/instance array identities across reload.
- Compute skill switches from the latest accepted config snapshot.
- Depend on a narrow `register(ReloadSource)` watcher interface, not concrete ReloadService.
- Keep `main.ts` unchanged and avoid presence-only assertions.

---

### Task 1: Skills service ownership and lifecycle

**Files:**
- Move: `apps/monad/src/bootstrap/skills.ts` to `apps/monad/src/capabilities/skills/service.ts`
- Create: `apps/monad/src/capabilities/skills/lifecycle.ts`
- Create: compatibility re-export at `apps/monad/src/bootstrap/skills.ts`
- Test: `apps/monad/test/unit/capabilities/skills-lifecycle.test.ts`

**Interfaces:**
- Produces `SkillWatchRegistrar`, existing `SkillSubsystem`, `createSkillSubsystem()`, and `createSkillsLifecycleModule()`.
- Consumes initial `ConfigSnapshot`, paths, monad version, and watcher registrar.

- [ ] **Step 1:** Write a failing test proving exact module metadata, atoms dependency, initial skill state, reload from a changed snapshot, stable subsystem output, and delegated stop-free lifecycle.
- [ ] **Step 2:** Run `bun scripts/bun-test.ts apps/monad/test/unit/capabilities/skills-lifecycle.test.ts --only-failures`; expect missing lifecycle module.
- [ ] **Step 3:** Move the service, replace its concrete ReloadService type with `SkillWatchRegistrar`, and add a lifecycle descriptor whose reload swaps the captured snapshot then awaits `reloadSkills()`.
- [ ] **Step 4:** Replace bootstrap file with `createSkillSubsystem` and type compatibility exports.
- [ ] **Step 5:** Run focused lifecycle tests, existing skill subsystem tests, Biome, complete main bundle, diff checks, and confirm `main.ts` is unchanged.
- [ ] **Step 6:** Commit with `feat(capabilities): add skills lifecycle`.
