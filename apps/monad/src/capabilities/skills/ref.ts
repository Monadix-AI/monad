import type { SkillRef } from './source.ts';

import { DEFAULT_SKILL_MARKETPLACE_SOURCE, skillMarketplaceSourceMeta } from '@monad/protocol';

const DEFAULT_SKILL_MARKETPLACE_PREFIX =
  skillMarketplaceSourceMeta(DEFAULT_SKILL_MARKETPLACE_SOURCE).installSourcePrefix ?? 'clawhub:';

export function parseSkillRef(raw: string): SkillRef {
  if (raw.startsWith('git+')) {
    return { raw, scheme: 'git', location: raw.slice(4) };
  }

  if (raw.startsWith('https://') || raw.startsWith('http://')) {
    return { raw, scheme: 'http', location: raw };
  }

  if (raw.startsWith('file:')) {
    return { raw, scheme: 'file', location: raw.slice(5) };
  }

  if (raw.startsWith('./') || raw.startsWith('/')) {
    return { raw, scheme: 'file', location: raw };
  }

  if (raw.startsWith(DEFAULT_SKILL_MARKETPLACE_PREFIX)) {
    const rest = raw.slice(DEFAULT_SKILL_MARKETPLACE_PREFIX.length);
    const atIdx = rest.indexOf('@');
    if (atIdx !== -1) {
      return { raw, scheme: 'clawhub', name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) };
    }
    return { raw, scheme: 'clawhub', name: rest };
  }

  // bare slug — default to default marketplace source scheme (`name`)
  const atIdx = raw.indexOf('@');
  if (atIdx !== -1) {
    return { raw, scheme: 'name', name: raw.slice(0, atIdx), version: raw.slice(atIdx + 1) };
  }
  return { raw, scheme: 'name', name: raw };
}
