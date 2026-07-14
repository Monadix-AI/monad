import { expect, test } from 'bun:test';

const root = new URL('../../../', import.meta.url);

test('production sources keep behavioral prompts in referenced .prompt.md assets', async () => {
  const tsSources = new Map<string, string>();
  for await (const path of new Bun.Glob('src/**/*.ts').scan({ cwd: root.pathname })) {
    tsSources.set(path, await Bun.file(new URL(path, root)).text());
  }
  const allSource = [...tsSources.values()].join('\n');
  const violations: string[] = [];
  const inlineBehavior =
    /['"`](?:You are |Return (?:ONLY|only|exactly)|Respond with valid JSON|Be precise and deterministic|Be creative and exploratory|Limit your response|New Workplace Project message|Provider session resume failed|Use this as shared project context|Earlier output from|Tool budget reached|Budget exceeded)/;

  for (const [path, source] of tsSources) {
    if (inlineBehavior.test(source)) violations.push(`${path}:inline-behavior`);
    if (/const\s+[A-Z_]*(?:SYSTEM|PROMPT)\s*=\s*\[/.test(source)) violations.push(`${path}:inline-array`);
    if (/await\s+Bun\.file\([^)]*(?:Prompt|PROMPT)/.test(source)) violations.push(`${path}:raw-prompt-file`);
  }

  let promptCount = 0;
  for await (const path of new Bun.Glob('src/**/*.prompt.md').scan({ cwd: root.pathname })) {
    promptCount++;
    const source = await Bun.file(new URL(path, root)).text();
    if (!source.trim()) violations.push(`${path}:empty`);
    if (/\{\{[A-Z][A-Z0-9_]*\}\}/.test(source)) violations.push(`${path}:legacy-slot`);
    if (!allSource.includes(path.split('/').at(-1) ?? path)) violations.push(`${path}:unreferenced`);
  }

  expect(promptCount).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});
