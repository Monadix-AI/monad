import type { SkillSortMode } from '@monad/protocol';
import type { ResolvedSkillContent, SkillDetail, SkillRef, SkillSearchResult, SkillSource } from '../source.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { HandlerError } from '#/handlers/handler-error.ts';

const log = createLogger('marketplace');
const BASE = 'https://clawhub.ai/api/v1';

const clawHubSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      score: z.number(),
      slug: z.string(),
      displayName: z.string(),
      summary: z.string(),
      version: z.string().optional(),
      downloads: z.number().optional(),
      updatedAt: z.number().optional(),
      ownerHandle: z.string().optional()
    })
  )
});
const clawHubListResponseSchema = z.object({
  items: z.array(
    z.object({
      slug: z.string(),
      displayName: z.string(),
      summary: z.string(),
      tags: z.object({ latest: z.string().optional() }).optional(),
      stats: z.object({ downloads: z.number().optional(), stars: z.number().optional() }).optional(),
      updatedAt: z.number().optional(),
      createdAt: z.number().optional()
    })
  )
});
const clawHubSkillResponseSchema = z.object({
  skill: z.object({
    slug: z.string(),
    displayName: z.string(),
    summary: z.string().optional(),
    description: z.string(),
    version: z.string().optional(),
    downloads: z.number().optional()
  })
});

export class ClawHubSkillSource implements SkillSource {
  readonly id: 'clawhub' = 'clawhub';

  match(ref: SkillRef): boolean {
    return ref.scheme === 'clawhub' || ref.scheme === 'name';
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkillContent> {
    const slug = ref.name ?? ref.raw;
    const url = `${BASE}/skills/${encodeURIComponent(slug)}`;
    let data: z.infer<typeof clawHubSkillResponseSchema>;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ClawHub returned ${res.status} for skill "${slug}"`);
      data = clawHubSkillResponseSchema.parse(await res.json());
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
    let data: z.infer<typeof clawHubListResponseSchema>;
    try {
      const res = await fetch(`${BASE}/skills?${params}`);
      if (!res.ok) {
        throw new Error(`ClawHub returned ${res.status}`);
      }
      data = clawHubListResponseSchema.parse(await res.json());
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
    let data: z.infer<typeof clawHubSearchResponseSchema>;
    try {
      const res = await fetch(`${BASE}/search?${params}`);
      if (!res.ok) {
        throw new Error(`ClawHub returned ${res.status}`);
      }
      data = clawHubSearchResponseSchema.parse(await res.json());
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
    let data: z.infer<typeof clawHubSkillResponseSchema>;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ClawHub returned ${res.status} for skill "${slug}"`);
      data = clawHubSkillResponseSchema.parse(await res.json());
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
