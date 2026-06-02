interface WeakAssertion {
  hint: string;
  line: number;
  match: string;
}

const BEHAVIOR_OK = /behavior-ok:\s*\S/;

function isWaived(lines: string[], line: number, waiver: RegExp): boolean {
  return waiver.test(lines[line - 1] ?? '') || waiver.test(lines[line - 2] ?? '');
}

export function findWeakAssertions(source: string): WeakAssertion[] {
  const lines = source.split('\n');
  const violations: WeakAssertion[] = [];
  for (const [index, text] of lines.entries()) {
    if (!text.includes('expect(') || isWaived(lines, index + 1, BEHAVIOR_OK)) continue;
    const statement =
      lines
        .slice(index, index + 12)
        .join('\n')
        .split(/;\s*(?:\n|$)/, 1)[0] ?? text;
    if (!/\.(?:toBe|toEqual)\(/.test(statement)) continue;

    const expectedName = statement.match(/expect\(\s*([A-Za-z_$][\w$]*)\s*\)/)?.[1];
    if (!expectedName) continue;
    const prior = lines.slice(Math.max(0, index - 60), index).join('\n');
    const declaration = prior.lastIndexOf(`const ${expectedName} =`);
    if (declaration < 0 || !/getComputedStyle|getBoundingClientRect|\.boundingBox\(/.test(prior.slice(declaration)))
      continue;

    const matcher = statement.match(/\.(?:toBe|toEqual)\([\s\S]*?\)/)?.[0] ?? '.toBe/toEqual(...)';
    violations.push({
      hint: 'exact CSS or geometry snapshots restate implementation — drive an operation and assert its observable effect',
      line: index + 1,
      match: matcher.replace(/\n\s*/g, ' ')
    });
  }
  return violations;
}
