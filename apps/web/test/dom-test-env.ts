import { afterEach, expect } from 'bun:test';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

// happy-dom is registered process-wide via `apps/web/bunfig.toml`'s `[test] preload` — see
// `register-dom-first.ts` for why a same-file or import-order trick can't do this instead. Call
// this at the top of any component test file that renders through `@testing-library/react`; it
// wires jest-dom matchers and unmounts rendered trees between tests so state doesn't leak across
// cases. Named without a `use` prefix on purpose — Biome's react-hook lint treats any `use*`-named
// function as a hook and rejects calling it at module top level, which is exactly where this must
// run.
export function setupDomTestEnvironment(): void {
  expect.extend(jestDomMatchers);
  afterEach(cleanup);
}
