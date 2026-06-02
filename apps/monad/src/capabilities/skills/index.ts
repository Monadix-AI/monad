import {
  SKILL_MARKETPLACE_SOURCES,
  type SkillDetail,
  type SkillMarketplaceSource,
  type SkillSearchResult,
  type SkillSortMode
} from '@monad/protocol';

export type { SkillRef } from './source.ts';

import type { SkillSource } from './source.ts';

import { ClawHubSkillSource } from './sources/clawhub.ts';
import { createRemoteMarketplaceSources } from './sources/marketplaces.ts';

export { parseSkillRef } from './ref.ts';

export { ClawHubSkillSource };

interface SkillCatalog {
  browse: (sort: SkillSortMode) => Promise<SkillSearchResult[]>;
  search: (query: string, sort?: SkillSortMode) => Promise<SkillSearchResult[]>;
  detail: (id: string) => Promise<SkillDetail>;
}

export type SkillCatalogs = Record<SkillMarketplaceSource, SkillCatalog>;

function toCatalog(source: SkillSource): SkillCatalog {
  return {
    browse: (sort) => source.browse?.(sort) ?? Promise.resolve([]),
    search: (query, sort) => source.search?.(query, sort) ?? Promise.resolve([]),
    async detail(id: string) {
      if (!source.fetchDetail) {
        throw new Error(`skill source "${source.id}" does not support detail lookup`);
      }
      return source.fetchDetail(id);
    }
  };
}

export function createSkillCatalogs(): SkillCatalogs {
  const clawhub = new ClawHubSkillSource();
  const remoteSources = createRemoteMarketplaceSources();
  const allSources: Record<SkillMarketplaceSource, SkillSource> = {
    clawhub,
    ...remoteSources
  };

  const catalogs = Object.fromEntries(
    SKILL_MARKETPLACE_SOURCES.map((entry) => {
      const source = allSources[entry.source];
      return [entry.source, toCatalog(source)];
    })
  );
  return catalogs as SkillCatalogs;
}
