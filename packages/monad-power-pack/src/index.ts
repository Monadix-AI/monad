export const MONAD_POWER_PACK_DEBUG_SOURCE = 'debug:monad-power-pack';
export const MONAD_POWER_PACK_GITHUB_SOURCE = 'github:monadix-labs/monad-power-pack@debug';

const manifest = {
  name: 'monad-power-pack',
  version: '0.0.1',
  sdkVersion: '0',
  atoms: ['skill'],
  entry: 'dist/atom-pack.js',
  description: 'A development atom pack for exercising remote-style installation and dynamic atom refresh.',
  author: 'Monadix Labs',
  source: {
    repo: 'monadix-labs/monad-power-pack',
    commit: 'debug'
  }
};

const bundle = `export default {
  manifest: ${JSON.stringify(manifest)},
  register() {}
};
`;

const placeholderSkill = `---
name: monad-power-pack-placeholder
description: Placeholder skill installed through the Monad Power Pack atom pack.
---

# Monad Power Pack Placeholder

Use this placeholder to verify atom pack installation, refresh, enable, disable, and removal flows.
`;

export function stagedMonadPowerPack(): {
  manifestRaw: unknown;
  bundle: Uint8Array;
  fileAtoms: { skills: string[]; mcpServers: string[]; locales: string[] };
  files: Map<string, Uint8Array>;
} {
  const enc = new TextEncoder();
  return {
    manifestRaw: manifest,
    bundle: enc.encode(bundle),
    fileAtoms: { skills: ['monad-power-pack-placeholder'], mcpServers: [], locales: [] },
    files: new Map([
      ['dist/atom-pack.js', enc.encode(bundle)],
      ['skills/monad-power-pack-placeholder/SKILL.md', enc.encode(placeholderSkill)]
    ])
  };
}
