import type { SkillSortMode } from '@monad/protocol';
import type { ResolvedSkillContent, SkillDetail, SkillRef, SkillSearchResult, SkillSource } from '../source.ts';

import { createLogger } from '@monad/logger';

import { HandlerError } from '@/handlers/handler-error.ts';

const log = createLogger('marketplace');
const BASE = 'https://clawhub.ai/api/v1';

interface ClawHubSearchResult {
  score: number;
  slug: string;
  displayName: string;
  summary: string;
  version?: string;
  downloads?: number;
  updatedAt?: number;
  ownerHandle?: string;
}

interface ClawHubSearchResponse {
  results: ClawHubSearchResult[];
}

interface ClawHubListResult {
  slug: string;
  displayName: string;
  summary: string;
  tags?: { latest?: string };
  stats?: { downloads?: number; stars?: number };
  updatedAt?: number;
  createdAt?: number;
}

interface ClawHubListResponse {
  items: ClawHubListResult[];
}

interface ClawHubSkillResponse {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    description: string;
    version?: string;
    downloads?: number;
  };
}

export class ClawHubSkillSource implements SkillSource {
  readonly id: 'clawhub' = 'clawhub';

  match(ref: SkillRef): boolean {
    return ref.scheme === 'clawhub' || ref.scheme === 'name';
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkillContent> {
    const slug = ref.name ?? ref.raw;
    const url = `${BASE}/skills/${encodeURIComponent(slug)}`;
    let data: ClawHubSkillResponse;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ClawHub returned ${res.status} for skill "${slug}"`);
      data = (await res.json()) as ClawHubSkillResponse;
    } catch (err) {
      log.warn({ slug, err }, 'clawhub skill resolve failed');
      throw err;
    }

    return {
      content: data.skill.description,
      name: data.skill.displayName,
      source: { id: this.id, ref: ref.raw }
    };
  }

  async latestVersion(slug: string): Promise<string | null> {
    const results = await this.search(slug);
    return results.find((r) => r.id === slug)?.version ?? null;
  }

  async browse(sort: SkillSortMode): Promise<SkillSearchResult[]> {
    // Only 'trending' is a valid server-side sort; top/new are sorted client-side.
    const params = new URLSearchParams(sort === 'trending' ? { sort: 'trending' } : {});
    let data: ClawHubListResponse;
    try {
      const res = await fetch(`${BASE}/skills?${params}`);
      if (!res.ok) {
        throw new Error(`ClawHub returned ${res.status}`);
      }
      data = (await res.json()) as ClawHubListResponse;
    } catch (err) {
      log.warn({ err }, 'clawhub browse failed');
      throw new HandlerError(
        'bad_gateway',
        `Failed to fetch ClawHub browse list: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let results = data.items.map((r) => ({
      id: r.slug,
      source: this.id,
      name: r.displayName,
      description: r.summary,
      score: null,
      version: r.tags?.latest ?? null,
      downloads: r.stats?.downloads ?? null
    }));

    if (sort === 'top') results = results.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    else if (sort === 'new') {
      const bySlug = new Map(data.items.map((r) => [r.slug, r.updatedAt ?? 0]));
      results = results.sort((a, b) => (bySlug.get(b.id) ?? 0) - (bySlug.get(a.id) ?? 0));
    }

    return results;
  }

  async search(query: string, sort?: SkillSortMode): Promise<SkillSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (sort) params.set('sort', sort);
    let data: ClawHubSearchResponse;
    try {
      const res = await fetch(`${BASE}/search?${params}`);
      if (!res.ok) {
        throw new Error(`ClawHub returned ${res.status}`);
      }
      data = (await res.json()) as ClawHubSearchResponse;
    } catch (err) {
      log.warn({ err }, 'clawhub search failed');
      throw new HandlerError(
        'bad_gateway',
        `Failed to search ClawHub: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return data.results.map((r) => ({
      id: r.slug,
      source: this.id,
      name: r.displayName,
      description: r.summary,
      score: r.score,
      version: r.version ?? null,
      downloads: r.downloads ?? null
    }));
  }

  async fetchDetail(slug: string): Promise<SkillDetail> {
    const url = `${BASE}/skills/${encodeURIComponent(slug)}`;
    let data: ClawHubSkillResponse;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ClawHub returned ${res.status} for skill "${slug}"`);
      data = (await res.json()) as ClawHubSkillResponse;
    } catch (err) {
      log.warn({ slug, err }, 'clawhub fetchDetail failed');
      throw err;
    }
    return {
      id: data.skill.slug,
      source: this.id,
      name: data.skill.displayName,
      summary: data.skill.summary ?? null,
      content: data.skill.description,
      downloads: data.skill.downloads ?? null,
      version: data.skill.version ?? null
    };
  }
}
