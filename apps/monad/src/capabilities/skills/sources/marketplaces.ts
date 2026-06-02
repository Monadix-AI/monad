import type { SkillMarketplaceSource, SkillSortMode } from '@monad/protocol';
import type { ResolvedSkillContent, SkillDetail, SkillRef, SkillSearchResult, SkillSource } from '../source.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { HandlerError } from '#/handlers/handler-error.ts';

const log = createLogger('marketplace');
const TTL_MS = 5 * 60 * 1000;
const skillsLlmDetailSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  codeRepository: z.string().optional(),
  url: z.string().optional()
});

interface MarketplaceRecord {
  id: string;
  source: SkillMarketplaceSource;
  name: string;
  description: string;
  content: string;
  summary?: string | null;
  version?: string | null;
  downloads?: number | null;
  homepage?: string | null;
  installSource?: string | null;
  updatedAt?: number | null;
  trendingScore?: number | null;
}

interface CacheEntry {
  expiresAt: number;
  records: MarketplaceRecord[];
}

const cache = new Map<SkillMarketplaceSource, CacheEntry>();

export function __clearRemoteMarketplaceCacheForTest(): void {
  cache.clear();
}

function decodeEscapes(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0027/g, "'")
    .replace(/\\u000a/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'monad-marketplace/1.0'
    }
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.text()).replace(/\0/g, '');
}

function githubRepoSource(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com') return null;
  return url;
}

function sortRecords(records: MarketplaceRecord[], sort: SkillSortMode): MarketplaceRecord[] {
  const sorted = [...records];
  if (sort === 'new') {
    sorted.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return sorted;
  }
  if (sort === 'top') {
    sorted.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    return sorted;
  }
  sorted.sort((a, b) => (b.trendingScore ?? b.downloads ?? 0) - (a.trendingScore ?? a.downloads ?? 0));
  return sorted;
}

function toSearchResult(record: MarketplaceRecord): SkillSearchResult {
  return {
    id: record.id,
    source: record.source,
    name: record.name,
    description: record.description,
    score: null,
    version: record.version ?? null,
    downloads: record.downloads ?? null,
    homepage: record.homepage ?? null,
    installSource: record.installSource ?? null
  };
}

function toDetail(record: MarketplaceRecord): SkillDetail {
  return {
    id: record.id,
    source: record.source,
    name: record.name,
    summary: record.summary ?? null,
    content: record.content,
    downloads: record.downloads ?? null,
    version: record.version ?? null,
    homepage: record.homepage ?? null,
    installSource: record.installSource ?? null
  };
}

function unique(records: MarketplaceRecord[]): MarketplaceRecord[] {
  const deduped = new Map<string, MarketplaceRecord>();
  for (const record of records) {
    if (!record.id || !record.name) continue;
    if (!deduped.has(record.id)) deduped.set(record.id, record);
  }
  return [...deduped.values()];
}

function parseSkillsSh(html: string): MarketplaceRecord[] {
  const searchableHtml = decodeEscapes(html);
  const pattern =
    /\{"source":"([^"]+)","skillId":"([^"]+)","name":"([^"]+)","installs":(\d+),"weeklyInstalls":\[([^\]]*)\](?:,"isOfficial":(true|false))?/g;
  const records: MarketplaceRecord[] = [];
  for (const match of searchableHtml.matchAll(pattern)) {
    const [, rawSourceRepo, rawSkillId, rawName, rawDownloads, rawWeeklyInstalls] = match;
    if (!rawSourceRepo || !rawSkillId || !rawName || !rawDownloads || rawWeeklyInstalls == null) continue;
    const sourceRepo = decodeEscapes(rawSourceRepo);
    const skillId = decodeEscapes(rawSkillId);
    const name = decodeEscapes(rawName);
    const downloads = Number(rawDownloads);
    const weeklyInstalls = rawWeeklyInstalls
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));
    const weeklyTotal = weeklyInstalls.reduce((sum, value) => sum + value, 0);
    records.push({
      id: skillId,
      source: 'skills.sh',
      name,
      description: `${sourceRepo}/${skillId}`,
      summary: sourceRepo,
      content: `# ${name}\n\nSource repo: \`${sourceRepo}\`\n\nSkill id: \`${skillId}\``,
      downloads,
      homepage: `https://skills.sh/${sourceRepo}/${skillId}`,
      installSource: `https://github.com/${sourceRepo}?skill=${encodeURIComponent(skillId)}`,
      trendingScore: weeklyTotal
    });
  }
  return unique(records);
}

function parseMcpServers(html: string): MarketplaceRecord[] {
  const searchableHtml = decodeEscapes(html);
  const pattern =
    /slug:"([^"]+)",skillName:"([^"]+)",name:"([^"]+)",description:"([^"]*)",url:"([^"]+)",downloadUrl:[^,]*,author:"([^"]*)"/g;
  const records: MarketplaceRecord[] = [];
  let index = 0;
  for (const match of searchableHtml.matchAll(pattern)) {
    const [, rawSlug, , rawName, rawDescription, rawRepoUrl, rawAuthor] = match;
    if (!rawSlug || !rawName || rawDescription == null || !rawRepoUrl || rawAuthor == null) continue;
    const slug = decodeEscapes(rawSlug);
    const name = decodeEscapes(rawName);
    const description = decodeEscapes(rawDescription);
    const repoUrl = decodeEscapes(rawRepoUrl);
    const author = decodeEscapes(rawAuthor);
    records.push({
      id: slug,
      source: 'mcpservers.org',
      name,
      description,
      summary: author || null,
      content: `# ${name}\n\n${description}\n\nFrom: ${author}`,
      homepage: `https://mcpservers.org/agent-skills/${slug}`,
      installSource: githubRepoSource(repoUrl),
      trendingScore: 10_000 - index
    });
    index += 1;
  }
  return unique(records);
}

function parseClaudeSkills(html: string): MarketplaceRecord[] {
  const pattern =
    /"slug":"([^"]+)","name":"([^"]+)","summary":"([^"]*)","description":"([^"]*)","repo_url":"([^"]+)","repo_owner":"([^"]*)","repo_name":"([^"]*)".*?"updated_at":"([^"]+)"(?:.*?"download_count":(\d+))?/g;
  const records: MarketplaceRecord[] = [];
  for (const match of html.matchAll(pattern)) {
    const [, rawSlug, rawName, rawSummary, rawDescription, rawRepoUrl, rawAuthor, , rawUpdatedAt, rawDownloads] = match;
    if (
      !rawSlug ||
      !rawName ||
      rawSummary == null ||
      rawDescription == null ||
      !rawRepoUrl ||
      rawAuthor == null ||
      !rawUpdatedAt
    ) {
      continue;
    }
    const slug = decodeEscapes(rawSlug);
    const name = decodeEscapes(rawName);
    const summary = decodeEscapes(rawSummary);
    const description = decodeEscapes(rawDescription);
    const repoUrl = decodeEscapes(rawRepoUrl);
    const _author = decodeEscapes(rawAuthor);
    const updatedAt = Date.parse(rawUpdatedAt);
    const downloads = rawDownloads ? Number(rawDownloads) : null;
    records.push({
      id: slug,
      source: 'ClaudeSkills.info',
      name,
      description: summary || description,
      summary: summary || null,
      content: description || summary || name,
      downloads,
      homepage: `https://claudeskills.info/skill/${slug}/`,
      installSource: githubRepoSource(repoUrl),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
      trendingScore: downloads
    });
  }
  return unique(records);
}

function parseSkillsLlmBrowse(html: string): MarketplaceRecord[] {
  const pattern =
    /href="\/skill\/([^"]+)">([^<]+)<\/a>[\s\S]{0,2200}?data-slot="card-description"[^>]*>([^<]+)<\/div>/g;
  const records: MarketplaceRecord[] = [];
  let index = 0;
  for (const match of html.matchAll(pattern)) {
    const [, rawSlug, rawName, rawDescription] = match;
    if (!rawSlug || !rawName || !rawDescription) continue;
    const slug = decodeEscapes(rawSlug);
    const name = decodeEscapes(rawName);
    const description = decodeEscapes(rawDescription.replace(/&amp;/g, '&').trim());
    records.push({
      id: slug,
      source: 'SkillsLLM',
      name,
      description,
      summary: null,
      content: description,
      homepage: `https://skillsllm.com/skill/${slug}`,
      trendingScore: 10_000 - index
    });
    index += 1;
  }
  return unique(records);
}

function parseSkillsLlmDetail(html: string, slug: string): SkillDetail {
  const ldJsonPattern =
    /<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"SoftwareApplication"[\s\S]*?)<\/script>/;
  const match = html.match(ldJsonPattern);
  let data: {
    name?: string;
    description?: string;
    codeRepository?: string;
    url?: string;
  } | null = null;
  if (match?.[1]) {
    try {
      data = skillsLlmDetailSchema.parse(JSON.parse(match[1]));
    } catch (err) {
      log.warn({ err, slug }, 'skillsllm ld+json parse failed');
      data = null;
    }
  }
  if (!data) {
    return {
      id: slug,
      source: 'SkillsLLM',
      name: slug,
      summary: null,
      content: slug,
      downloads: null,
      version: null,
      homepage: `https://skillsllm.com/skill/${slug}`,
      installSource: null
    };
  }
  return {
    id: slug,
    source: 'SkillsLLM',
    name: data.name ?? slug,
    summary: data.description ?? null,
    content: data.description ?? data.name ?? slug,
    downloads: null,
    version: null,
    homepage: data.url ?? `https://skillsllm.com/skill/${slug}`,
    installSource: githubRepoSource(data.codeRepository ?? '')
  };
}

async function loadMarketplace(source: SkillMarketplaceSource): Promise<MarketplaceRecord[]> {
  const cached = cache.get(source);
  if (cached && cached.expiresAt > Date.now()) return cached.records;

  try {
    const records = await (async () => {
      switch (source) {
        case 'skills.sh':
          return parseSkillsSh(await fetchText('https://skills.sh/'));
        case 'mcpservers.org':
          return parseMcpServers(await fetchText('https://mcpservers.org/agent-skills'));
        case 'ClaudeSkills.info':
          return parseClaudeSkills(await fetchText('https://claudeskills.info/'));
        case 'SkillsLLM':
          return parseSkillsLlmBrowse(await fetchText('https://skillsllm.com/'));
        case 'clawhub':
          return [];
      }
    })();
    cache.set(source, { records, expiresAt: Date.now() + TTL_MS });
    return records;
  } catch (err) {
    log.warn({ err, source }, 'marketplace scrape failed');
    throw new HandlerError(
      'bad_gateway',
      `Failed to fetch marketplace "${source}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

class RemoteMarketplaceSkillSource implements SkillSource {
  constructor(readonly id: Exclude<SkillMarketplaceSource, 'clawhub'>) {}

  match(ref: SkillRef): boolean {
    return ref.scheme === 'http' && ref.raw === this.id;
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkillContent> {
    const detail = await this.fetchDetail(ref.raw);
    return {
      content: detail.content,
      name: detail.name,
      source: { id: this.id, ref: ref.raw }
    };
  }

  async browse(sort: SkillSortMode): Promise<SkillSearchResult[]> {
    return sortRecords(await loadMarketplace(this.id), sort).map(toSearchResult);
  }

  async search(query: string, sort?: SkillSortMode): Promise<SkillSearchResult[]> {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? (await loadMarketplace(this.id)).filter((record) =>
          [record.id, record.name, record.description, record.summary, record.content].some((field) =>
            field?.toLowerCase().includes(needle)
          )
        )
      : await loadMarketplace(this.id);
    return sortRecords(filtered, sort ?? 'trending').map(toSearchResult);
  }

  async fetchDetail(id: string): Promise<SkillDetail> {
    if (this.id === 'SkillsLLM') {
      return parseSkillsLlmDetail(await fetchText(`https://skillsllm.com/skill/${encodeURIComponent(id)}`), id);
    }
    const record = (await loadMarketplace(this.id)).find((entry) => entry.id === id);
    if (!record) throw new Error(`skill "${id}" not found in ${this.id}`);
    return toDetail(record);
  }
}

export function createRemoteMarketplaceSources(): Record<Exclude<SkillMarketplaceSource, 'clawhub'>, SkillSource> {
  return {
    'skills.sh': new RemoteMarketplaceSkillSource('skills.sh'),
    'mcpservers.org': new RemoteMarketplaceSkillSource('mcpservers.org'),
    'ClaudeSkills.info': new RemoteMarketplaceSkillSource('ClaudeSkills.info'),
    SkillsLLM: new RemoteMarketplaceSkillSource('SkillsLLM')
  };
}
