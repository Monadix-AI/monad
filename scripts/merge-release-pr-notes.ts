#!/usr/bin/env bun

export function mergeReleasePrNotes(body: string, generatedNotes: string): string {
  const lines = body.trim().replaceAll('\r\n', '\n').split('\n');
  const delimiters = lines.flatMap((line, index) => (line === '---' ? [index] : []));
  if (delimiters.length < 2) throw new Error('release PR body must contain Release Please delimiters');

  const firstDelimiter = delimiters[0] as number;
  const lastDelimiter = delimiters.at(-1) as number;
  const versionHeading = lines
    .slice(firstDelimiter + 1, lastDelimiter)
    .find((line) => /^#{2,}\s+\[?\d+\.\d+\.\d+/.test(line));
  if (!versionHeading) throw new Error('release PR body must contain a version heading');

  return [
    ...lines.slice(0, firstDelimiter + 1),
    '',
    versionHeading,
    '',
    generatedNotes.trim(),
    '',
    ...lines.slice(lastDelimiter),
    ''
  ].join('\n');
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

if (import.meta.main) {
  const bodyPath = argument('body');
  const notesPath = argument('notes');
  const outputPath = argument('output');
  const merged = mergeReleasePrNotes(await Bun.file(bodyPath).text(), await Bun.file(notesPath).text());
  await Bun.write(outputPath, merged);
}
