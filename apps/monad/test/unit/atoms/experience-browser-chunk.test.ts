import { expect, test } from 'bun:test';

import { checkExperienceBrowserChunk } from '#/atoms/browser-chunk.ts';

test('a browser module that only uses browser APIs is servable', () => {
  const code = `
    import { WORKPLACE_EXPERIENCE_UPDATE_EVENT } from '@monad/sdk-experience';
    customElements.define('my-canvas', class extends HTMLElement {});
  `;

  expect(checkExperienceBrowserChunk(code)).toEqual([]);
});

test('importing a Node or Bun builtin makes the module unservable', () => {
  expect(checkExperienceBrowserChunk("import { readFile } from 'node:fs';")).toEqual([
    'imports a Node or Bun builtin, which cannot resolve in a browser'
  ]);
  expect(checkExperienceBrowserChunk("const db = await import('bun:sqlite');")).toEqual([
    'imports a Node or Bun builtin, which cannot resolve in a browser'
  ]);
});

test('reaching into daemon packages or host-private aliases is rejected', () => {
  expect(checkExperienceBrowserChunk("import { AtomPackRegistry } from '@monad/monad';")).toEqual([
    'imports a daemon-side package instead of the public experience contract'
  ]);
  expect(checkExperienceBrowserChunk("import { paths } from '#/atoms/lifecycle.ts';")).toEqual([
    'imports a host-private path alias'
  ]);
});

test('a bundled React runtime is rejected', () => {
  expect(checkExperienceBrowserChunk("import { jsx } from 'react/jsx-runtime';")).toEqual([
    'bundles React, which a web-component experience must not carry'
  ]);
});

test('naming a forbidden module in a string is not an import', () => {
  const code = `
    const help = 'this experience replaces the node:fs based flow';
    element.dataset.hint = "react";
  `;

  expect(checkExperienceBrowserChunk(code)).toEqual([]);
});

test('every violation in one module is reported together', () => {
  const code = `
    import { readFile } from 'node:fs';
    import { jsx } from 'react/jsx-runtime';
  `;

  expect(checkExperienceBrowserChunk(code)).toEqual([
    'imports a Node or Bun builtin, which cannot resolve in a browser',
    'bundles React, which a web-component experience must not carry'
  ]);
});
