import { expect, test } from 'bun:test';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAgentCredentialManifest, renderAgentSystemPrompt } from '#/agent/prompts.ts';

const rootUrl = new URL('../../../', import.meta.url);
const root = fileURLToPath(rootUrl);

/** Reads every match at once. Awaiting inside the scan loop serializes ~600 reads, which is
 *  imperceptible on Linux and takes over 15 seconds on Windows. */
async function readAll(pattern: string): Promise<Map<string, string>> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root })) paths.push(path);
  const sources = await Promise.all(paths.map((path) => Bun.file(new URL(path, rootUrl)).text()));
  return new Map(paths.map((path, index) => [path, sources[index] as string]));
}

test('production sources keep behavioral prompts in referenced .prompt.md assets', async () => {
  const [tsSources, promptSources] = await Promise.all([readAll('src/**/*.ts'), readAll('src/**/*.prompt.md')]);
  const allSource = [...tsSources.values()].join('\n');
  const violations: string[] = [];
  const inlineBehavior =
    /['"`](?:You are |Return (?:ONLY|only|exactly)|Respond with valid JSON|Be precise and deterministic|Be creative and exploratory|Limit your response|New Workplace Project message|Provider session resume failed|Use this as shared project context|Earlier output from|Tool budget reached|Budget exceeded)/;

  for (const [path, source] of tsSources) {
    if (inlineBehavior.test(source)) violations.push(`${path}:inline-behavior`);
    if (/const\s+[A-Z_]*(?:SYSTEM|PROMPT)\s*=\s*\[/.test(source)) violations.push(`${path}:inline-array`);
    if (/await\s+Bun\.file\([^)]*(?:Prompt|PROMPT)/.test(source)) violations.push(`${path}:raw-prompt-file`);
  }

  for (const [path, source] of promptSources) {
    if (!source.trim()) violations.push(`${path}:empty`);
    if (/\{\{[A-Z][A-Z0-9_]*\}\}/.test(source)) violations.push(`${path}:legacy-slot`);
    if (!allSource.includes(basename(path))) violations.push(`${path}:unreferenced`);
  }

  expect(promptSources.size).toBeGreaterThan(0);
  expect(violations).toEqual([]);
}, 15_000);

test('Credential prompt projection never serializes a secret canary', () => {
  const secret = 'prompt-source-secret-canary';
  const manifest = renderAgentCredentialManifest([
    {
      label: 'Canary',
      environmentVariable: 'CANARY_TOKEN',
      allowedHosts: ['api.example.com']
    }
  ]);
  const prompt = renderAgentSystemPrompt({ slots: { credentials: manifest }, skills: [], toolNames: [] });
  const diagnostics = JSON.stringify({ systemPrompt: prompt, slots: { credentials: manifest } });

  expect({ manifest, prompt, diagnostics }).toEqual({
    manifest,
    prompt,
    diagnostics
  });
  expect(diagnostics).not.toContain(secret);
});
