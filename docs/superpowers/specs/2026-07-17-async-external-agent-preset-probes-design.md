# Async External Agent Preset Probes Design

## Problem

`GET /v1/settings/external-agents/presets` probes every installed provider CLI on the HTTP request path. The current implementation uses sequential `spawnSync` calls. On the observed machine one refresh executes Codex twice, Claude Code twice, Gemini once, OpenClaw once, and Hermes once. The combined probe time is normally 1.8–2.7 seconds.

Because these processes run synchronously on Bun's main event loop, unrelated requests cannot be accepted or completed during the refresh. Daemon logs show project-session requests completing in 1–2 ms and static assets in 0–1 ms, but only after the preset request releases the event loop. Browser DevTools therefore reports the whole request group as taking roughly three seconds.

## Goal

Make provider capability discovery non-blocking and avoid repeated work while preserving the existing preset response contract and fallback behavior.

Success means:

- a pending provider probe does not prevent timers, session handlers, or static asset handlers from running;
- unique provider commands execute concurrently;
- identical launch commands within one refresh execute once and their output can feed multiple parsers;
- every preset request performs a fresh probe without retaining results across requests;
- a missing executable, timeout, non-zero exit, or parse failure degrades to the adapter's static model and capability defaults;
- no new setting, environment variable, dependency, or wire-contract field is introduced.

## Considered Approaches

### Async per-request probe batch with command deduplication

For each request, resolve launch specs synchronously, execute unique commands through asynchronous `Bun.spawn`, and apply the existing adapter parsers after output is collected. Do not retain completed results or in-flight work across HTTP requests.

This is the selected approach. It removes main-loop blocking and reduces every refresh to approximately the slowest provider command while guaranteeing that each response reflects a fresh probe.

### Worker around the existing synchronous implementation

Running the current function in a Worker would free the HTTP event loop with fewer changes. It would retain duplicate CLI executions, require worker packaging and lifecycle handling in both development and compiled releases, and obscure the probe boundary.

### Synchronous cache only

Caching the existing result would make warm reads fast but preserve the multi-second daemon freeze on every cold refresh. It does not satisfy the primary requirement.

## Architecture

### Probe execution

Add a focused async probe runner under the external-agent service. It accepts a resolved `ExternalAgentLaunchSpec` and returns stdout, stderr, and exit code. It uses `Bun.spawn`, drains both output streams, enforces the existing 2,000 ms timeout, and kills a timed-out child. Provider errors are data for fallback, not request failures.

The runner is dependency-injected into the per-request batch function for deterministic tests. Production uses the Bun implementation.

### Refresh planning and deduplication

For each registered adapter, construct the base preset exactly as today. Collect its optional argument-support probe and model-options probe. Resolve each launch command through the existing binary-resolution boundary.

Group resolved probes by an exact execution identity consisting of executable, arguments, working directory, and effective environment. Execute all unique groups concurrently with `Promise.all`. Each consumer retains its own parser, so Codex and Claude Code can derive both argument support and model options from one command output without changing adapter contracts.

An unresolved executable skips execution and uses fallback values.

### Request lifecycle

`listExternalAgentPresets` becomes asynchronous. Each invocation owns one probe batch:

- base presets and probe consumers are collected for that invocation;
- identical execution identities inside that invocation share one command result;
- all unique commands start concurrently;
- all results are released after the response is built.

Two concurrent HTTP requests run independent batches. There is no completed-result cache, TTL, stale response, background refresh, or cross-request in-flight promise. A preset request still awaits provider discovery, but the asynchronous processes do not block unrelated HTTP work and execute concurrently.

The settings handler awaits the async service function. The HTTP response schema remains `{ presets: ExternalAgentPresetView[] }`.

### Failure behavior

Failures are isolated per execution group. A failed argument-support probe yields empty reasoning efforts. A failed or empty model probe yields the adapter's existing static supported-model list. One broken provider never rejects the entire endpoint.

If a batch unexpectedly fails outside a provider probe, the service rebuilds base presets with static fallbacks for that response. No failed or successful result is retained.

No command output, environment value, or executable arguments are logged by the new path.

## Scope

This change covers the preset endpoint responsible for the observed event-loop stall. Configured-agent reads keep their current behavior; broad settings-service refactoring is outside this fix. The response contract, adapters, installation detection, and UI query behavior remain unchanged.

## Testing

Tests will establish the behavior in red-green order:

1. a deferred async runner leaves the JavaScript event loop responsive while a cold refresh is pending;
2. multiple unique provider commands start before any one completes;
3. identical launch specs execute once within one request while both parsers receive the result;
4. a second request performs a new probe batch rather than reusing prior results;
5. simultaneous requests do not share retained state;
6. timeout, launch failure, non-zero exit, and parser failure preserve static fallbacks;
7. the existing external-agent settings HTTP suite still returns the exact preset contract.

After unit and handler tests pass, verification includes lint, typecheck, the full test suite, local deployment, and a live check showing that a deliberately cold preset request no longer delays a concurrent sessions or static-asset request.
