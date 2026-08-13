import { GlobalRegistrator } from '@happy-dom/global-registrator';

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
document.open();
document.write('<!doctype html><html><head></head><body></body></html>');
document.close();
Object.defineProperty(document, 'compatMode', { configurable: true, value: 'CSS1Compat' });

for (const key of NATIVE_GLOBALS) {
  (globalThis as Record<string, unknown>)[key] = nativeGlobals[key];
}

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
