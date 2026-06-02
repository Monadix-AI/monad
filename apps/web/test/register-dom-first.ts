import { GlobalRegistrator } from '@happy-dom/global-registrator';

// `@testing-library/dom`'s `screen` singleton snapshots whether `document` exists AT MODULE
// EVALUATION TIME (not lazily per-call) — registering happy-dom after `@testing-library/react`
// has already been imported leaves `screen` permanently bound to its "no document" failure path.
// A same-file ordering trick can't fix this: ES `import` declarations are hoisted above every
// other statement in the module regardless of where they're written, so evaluation order is
// governed by the import graph, not by source-line position. `apps/web`'s suite also runs every
// test/unit file in one Bun process, so this must run via `--preload` (apps/web/bunfig.toml) —
// the only mechanism that runs before ANY test file's module graph is resolved — not via a
// same-file or even a separate-file import ordering trick, both of which were tried and failed.
// happy-dom's network/encoding primitive polyfills (fetch, Request/Response/Headers, Blob, ...)
// only understand data routed through its own window and don't interop with Bun's native
// versions of the same classes. Real tests elsewhere in this suite build native `Blob`s from
// `Bun.embeddedFiles`, serve them through native `Response`, and issue genuine loopback HTTP
// requests against a `Bun.serve()` fixture (`web-assets.test.ts`, `web.test.ts`'s `readDaemonUrl`
// cases) — under the polyfill a native `Blob` fed to a happy-dom `Response` isn't recognized as a
// valid body and gets silently stringified to `"[object Blob]"`. RTL only needs the DOM globals
// (document/window/Element/Event/…), so snapshot and restore Bun's native versions of every
// network/encoding primitive `GlobalRegistrator` overwrites.
const NATIVE_GLOBALS = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'Blob',
  'File',
  'FormData',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'WebSocket',
  'crypto',
  'Crypto',
  'performance',
  'AbortController',
  'AbortSignal'
] as const;
const nativeGlobals = Object.fromEntries(
  NATIVE_GLOBALS.map((key) => [key, (globalThis as Record<string, unknown>)[key]])
);
GlobalRegistrator.register();
for (const key of NATIVE_GLOBALS) {
  (globalThis as Record<string, unknown>)[key] = nativeGlobals[key];
}

// Radix primitives (Select, Popover, …) call pointer-capture/scroll APIs happy-dom doesn't
// implement; no-op them so interaction tests can drive real click/keyboard events through them.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
