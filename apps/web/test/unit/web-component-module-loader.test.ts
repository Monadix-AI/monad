import { expect, test } from 'bun:test';

const source = await Bun.file(
  new URL('../../src/features/workplace/experiences/web-component/WebComponentExperience.tsx', import.meta.url)
).text();

test('leaves public web-component modules to the browser instead of Vite transforms', () => {
  expect(source).toContain("script.type = 'module'");
  expect(source).toContain('document.head.append(script)');
  expect(source).toContain('loadWebComponentModule(atom.entry.module)');
  expect(source).not.toMatch(/import\(\/\* .*ignore.*\*\/ atom\.entry\.module\)/);
});
