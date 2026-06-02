import type { SkillDetail, SkillSearchResult, SkillSortMode } from '@monad/protocol';

export type { SkillDetail, SkillSearchResult } from '@monad/protocol';

export interface SkillRef {
  raw: string;
  scheme: 'name' | 'clawhub' | 'git' | 'http' | 'file';
  name?: string;
  version?: string;
  location?: string;
}

export interface ResolvedSkillContent {
  content: string;
  name: string;
  source: { id: string; ref: string };
}

export interface SkillSource {
  id: string;
  match(ref: SkillRef): boolean;
  resolve(ref: SkillRef): Promise<ResolvedSkillContent>;
  browse?(sort: SkillSortMode): Promise<SkillSearchResult[]>;
  search?(query: string, sort?: SkillSortMode): Promise<SkillSearchResult[]>;
  fetchDetail?(slug: string): Promise<SkillDetail>;
}
