# Daemon Runtime Migration Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the daemon lifecycle migration so production startup, reload, and shutdown use RuntimeKernel and ConfigService rather than statement-order bootstrap and ConfigBus.

**Architecture:** Finish stable MCP/channel/transport facades, then assemble all lifecycle descriptors in `runtime/create.ts`. Migrate `main.ts` to consume RuntimeContext outputs, route disk and settings invalidations through ConfigService, and move remaining composition helpers to their owning domains. Delete compatibility bootstrap files and ConfigBus only after repository references reach zero.

**Tech Stack:** Bun 1.3, TypeScript, RuntimeKernel, Zustand vanilla lifecycle state, ConfigService, `bun:test`.

## Global Constraints

- Use Bun only and TDD for new behavior.
- Preserve TCP loopback and Unix socket behavior.
- No RxJS, revision queue, service locator, or runtime objects in Zustand.
- AgentLoop remains per-turn.
- Required startup failure rolls back; optional MCP/channel failures degrade without aborting.
- Config file storms use trailing debounce, single-flight, and final-state application.
- Remove existence-only tests encountered in touched files unless absence is a business path.

---

### Task 1: MCP stable lifecycle facade

Move `bootstrap/mcp.ts` to `capabilities/mcp/service.ts`, retain temporary exports, and add `capabilities/mcp/lifecycle.ts`. The required `capabilities.mcp` module depends on `capabilities` and `atoms`; connection failures remain per-server nonfatal. Its stable output owns config and file connections, reload diff/reconnect, getters, and idempotent stop. Verify focused MCP and runtime tests, then commit.

### Task 2: Production runtime assembly

Extend `runtime/create.ts` with a production module factory for store, sandbox, model, capabilities, atoms, skills, and MCP. Add an owned filesystem watcher service and home ConfigSource watch adapter. Test dependency layers, output retrieval, config reload, and reverse shutdown. Commit independently.

### Task 3: Migrate main startup

Replace direct construction of migrated subsystems in `main.ts` with production runtime start and typed RuntimeContext outputs. Keep later handler assembly unchanged initially. Verify startup-focused tests, both transport suites, and main bundle. Commit.

### Task 4: Replace ConfigBus and legacy hot reload

Move config-derived hook/persona/workspace state into a reloadable domain facade. Convert current hot-reload work into lifecycle reload methods or one co-located application facade where services are inherently assembled together. Change settings write paths to call ConfigService refresh/flush instead of publishing events. Delete `services/config-bus.ts`, `bootstrap/hot-reload.ts`, and settings file watching from legacy config-watchers after references reach zero. Verify storm/final-update tests and settings HTTP tests. Commit.

### Task 5: Channels and transports lifecycle

Move channel gateway and serving ownership into `channels/lifecycle.ts` and `transports/lifecycle.ts`. Required local listeners and optional channels expose explicit stop; full-ready is emitted only after terminal channel state. Preserve TCP/Unix parity and stdio branch. Verify both transports and listener shutdown tests. Commit.

### Task 6: Remove bootstrap compatibility layer and finish

Move remaining one-file composition helpers into existing domains, update imports, delete empty compatibility files/directories, and keep `runtime/` limited to kernel mechanics plus `create.ts`. Run Biome, typecheck/error collection, focused tests, full daemon tests, knip, main/release bundle, and `git diff --check`. Document only known pre-existing failures with exact output; commit the cleanup.
