// What a workplace experience's browser module may not contain. Monad ships no builder for
// experience authors — they bundle with whatever they like — so this is where the artifact contract
// is actually held: the daemon refuses to serve a module that could not work in a browser, or that
// reached past the public contract to grab host internals.
//
// Matched on import syntax rather than bare substrings: a module that merely mentions "node:fs" in a
// string is fine, one that imports it is not. Refusal is a real consequence, so a false positive
// costs more here than a missed obfuscation — and obfuscation is not in scope anyway (an experience
// runs in the operator's own browser, under the permissions its manifest declared).

const SPECIFIER = String.raw`(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]`;

const RULES: { re: RegExp; violation: string }[] = [
  {
    re: new RegExp(`${SPECIFIER}(?:node|bun):`),
    violation: 'imports a Node or Bun builtin, which cannot resolve in a browser'
  },
  {
    re: new RegExp(`${SPECIFIER}@monad/(?:monad|environment|sdk-atom)\\b`),
    violation: 'imports a daemon-side package instead of the public experience contract'
  },
  {
    re: new RegExp(`${SPECIFIER}#/`),
    violation: 'imports a host-private path alias'
  },
  {
    re: new RegExp(`${SPECIFIER}react(?:-dom)?(?:/|['"])`),
    violation: 'bundles React, which a web-component experience must not carry'
  }
];

/** Contract violations found in an experience's browser module. Empty means the module is servable. */
export function checkExperienceBrowserChunk(code: string): string[] {
  return RULES.filter(({ re }) => re.test(code)).map(({ violation }) => violation);
}
