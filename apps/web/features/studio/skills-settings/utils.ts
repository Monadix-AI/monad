import type { MonadClient } from '@monad/client';
import type { SkillListInstance } from '@monad/protocol';

import { getSkillContentResponseSchema } from '@monad/protocol';

export function githubSourceDetails(source?: string): { address: string; ref?: string } | null {
  if (!source) return null;
  if (source.startsWith('github:')) {
    const raw = source.slice('github:'.length);
    const [address, ref] = raw.split('@', 2);
    if (!address) return null;
    return { address: `github:${address}`, ref };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repoWithSuffix, marker, ref] = parts;
  const repo = repoWithSuffix?.replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return {
    address: `https://github.com/${owner}/${repo}`,
    ref: (marker === 'tree' || marker === 'blob') && ref ? ref : undefined
  };
}

export function githubRefKind(ref?: string): 'main' | 'branch' {
  return ref === undefined || ref === 'main' || ref === 'master' || ref === 'trunk' ? 'main' : 'branch';
}

export function githubRepositoryHref(address: string): string {
  return address.startsWith('github:') ? `https://github.com/${address.slice('github:'.length)}` : address;
}

function compareSkillNames(a: SkillListInstance, b: SkillListInstance): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export function sortSkillInstancesByName(skills: SkillListInstance[]): SkillListInstance[] {
  return [...skills].sort(compareSkillNames);
}

export function isHttpIcon(icon: string | undefined): boolean {
  return Boolean(icon && /^https?:\/\//.test(icon));
}

/** Returns the URL only when it is a plain http(s) link — guards against `javascript:`/`data:`
 *  schemes reaching an `href` or CSS `url()` from untrusted marketplace/skill metadata. */
export function safeHttpUrl(url: string | null | undefined): string | undefined {
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

export function formatDate(value?: string): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

export function formatAttachmentSize(size?: number): string {
  const attachmentSize = size ?? 0;
  if (attachmentSize <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = attachmentSize;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex];
  if (unitIndex === 0) {
    return `${Math.round(value)} ${unit}`;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content.trimStart());
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split('\n')) {
    const field = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    const value = field[2]?.trim().replace(/^['"]|['"]$/g, '');
    if (field[1] === 'name') out.name = value;
    if (field[1] === 'description') out.description = value;
  }
  return out;
}

export function parseSkillPreview(content: string): { metadata: Array<[string, string]>; body: string } {
  const trimmed = content.trimStart();
  const match = /^---\s*\n([\s\S]*?)\n---\s*/.exec(trimmed);
  if (!match) return { metadata: [], body: content };
  const metadata = match[1]
    .split('\n')
    .map((line): [string, string] | null => {
      const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (!field) return null;
      return [field[1], field[2]?.trim().replace(/^['"]|['"]$/g, '') ?? ''];
    })
    .filter((row): row is [string, string] => row !== null);
  return { metadata, body: trimmed.slice(match[0].length) };
}

export function normalizeGithubSkillSource(raw: string): string | null {
  const value = raw.trim();
  const shorthand = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_./-]+))?$/.exec(value);
  if (shorthand) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const marker = parts[2];
  if ((marker === 'tree' || marker === 'blob') && parts.length > 3) {
    const refAndPath = parts.slice(3).join('/');
    if (!/^[A-Za-z0-9_./-]+$/.test(refAndPath)) return null;
    return `https://github.com/${owner}/${repo}/${marker}/${refAndPath}`;
  }
  return `github:${owner}/${repo}`;
}

export async function loadSkillContent(
  skill: Pick<SkillListInstance, 'id' | 'name'>,
  client: MonadClient,
  file?: string
) {
  const params = new URLSearchParams();
  if (skill.id) params.set('id', skill.id);
  if (file) params.set('file', file);
  const qs = params.toString() ? `?${params}` : '';
  const res = await client.fetch(`/v1/atoms/skills/${encodeURIComponent(skill.name)}/content${qs}`);
  const body = await res.json();
  if (!res.ok) throw new Error('failed to load skill content');
  return getSkillContentResponseSchema.parse(body);
}
