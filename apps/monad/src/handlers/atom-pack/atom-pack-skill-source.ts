import type { MonadAuth, MonadConfig } from '@monad/home';

import { join } from 'node:path';
import { DEFAULT_SAMPLE_PROVIDER_ID } from '@monad/home';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE, skillMarketplaceSourceMeta } from '@monad/protocol';

import { type SkillInstallRecord, skillInstallRecordSchema } from '#/capabilities/skills/install/index.ts';

const DEFAULT_SKILL_INSTALL_SOURCE_PREFIX = skillMarketplaceSourceMeta(
  DEFAULT_SKILL_MARKETPLACE_SOURCE
).installSourcePrefix;

export function isGithubHttpSource(source: string): boolean {
  try {
    const url = new URL(source);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

export function isDefaultMarketplaceSourceSpec(source: string): boolean {
  if (DEFAULT_SKILL_INSTALL_SOURCE_PREFIX && source.startsWith(DEFAULT_SKILL_INSTALL_SOURCE_PREFIX)) {
    return true;
  }
  return !source.includes(':');
}

export function resolveUsableInstallReviewModel(cfg: MonadConfig, auth: MonadAuth | null): string | null {
  if (!auth) return null;
  const profiles = [
    ...cfg.model.profiles.filter((p) => p.alias === 'default'),
    ...cfg.model.profiles.filter((p) => p.alias !== 'default')
  ];
  for (const profile of profiles) {
    const provider = cfg.model.providers.find((p) => p.id === profile.routes.chat.provider);
    if (!provider || provider.id === DEFAULT_SAMPLE_PROVIDER_ID) continue;
    if ((auth.credentialPool[provider.id] ?? []).some((credential) => credential.authType !== 'admin_api_key')) {
      return profile.alias;
    }
  }
  return null;
}

export async function readSkillRecord(skillsDir: string, name: string): Promise<SkillInstallRecord | undefined> {
  try {
    const parsed = skillInstallRecordSchema.safeParse(
      JSON.parse(await Bun.file(join(skillsDir, name, '.install.json')).text())
    );
    return parsed.success ? parsed.data : undefined; // hand-dropped / other-source / malformed
  } catch {
    return undefined; // hand-dropped skill — no install record
  }
}
