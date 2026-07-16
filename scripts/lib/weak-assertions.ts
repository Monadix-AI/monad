interface WeakAssertion {
  hint: string;
  line: number;
  match: string;
}

interface WeakPattern {
  hint: string;
  pattern: RegExp;
}

// `not.toBeInTheDocument()` on a queryBy* result is the canonical RTL absence
// contract, so only the positive form is flagged.
const weakPatterns: WeakPattern[] = [
  {
    hint: 'existence proves nothing — assert the exact value or contract shape',
    pattern: /(?<!\.not)\.(?:toBeDefined|toBeTruthy)\(\)/g
  },
  {
    hint: 'assert the exact falsy contract (toBe(false), toBeNull, toEqual) instead',
    pattern: /(?<!\.not)\.toBeFalsy\(\)/g
  },
  {
    hint: 'existence phrased as double negative — assert the exact value instead',
    pattern: /\.not\.(?:toBeNull|toBeUndefined|toBeFalsy)\(\)/g
  },
  {
    hint: 'getBy* already throws when absent; interact with the element and assert the effect',
    pattern: /(?<!\.not)\.toBeInTheDocument\(\)/g
  },
  {
    hint: 'discarded value — assert on it or remove it',
    pattern: /\b(?:const|let)\s+_[A-Za-z][A-Za-z0-9_]*\s*=/g
  },
  {
    hint: 'empty test body asserts nothing',
    pattern: /\b(?:test|it)\([^{}]*=>\s*\{\s*\}\s*\);/g
  }
];

const PRESENCE_OK = /presence-ok:\s*\S/;

export function findWeakAssertions(source: string): WeakAssertion[] {
  const lines = source.split('\n');
  const violations: WeakAssertion[] = [];
  for (const { hint, pattern } of weakPatterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      const waived = PRESENCE_OK.test(lines[line - 1] ?? '') || PRESENCE_OK.test(lines[line - 2] ?? '');
      if (!waived) violations.push({ hint, line, match: match[0] });
    }
  }
  return violations.sort((a, b) => a.line - b.line);
}
