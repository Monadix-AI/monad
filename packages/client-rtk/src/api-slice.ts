import type { PaginateResponse } from '@monad/protocol';
import type { MonadApiError } from './endpoint-helpers.ts';

import { type EntityState } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

/**
 * Replaces the array field K in response R with EntityState, preserving all other fields.
 * Mirrors the cabinet project's NormalizedPaginateResponse pattern.
 */
export type NormalizedPaginateResponse<T, K extends string, R extends { [P in K]: T[] }> = Omit<
  PaginateResponse<R, K>,
  K
> & {
  [P in K]: EntityState<T, string>;
};

/**
 * Same normalization for cursor-paginated responses (`nextCursor`, not `limit`/`offset`/`total`).
 * `R` is the full response shape (e.g. `ListMemoryFactsResponse`); `K` is its array field name.
 */
export type NormalizedCursorPaginateResponse<T, K extends string, R extends { [P in K]: T[] }> = Omit<R, K> & {
  [P in K]: EntityState<T, string>;
};

export const apiSlice = createApi({
  reducerPath: 'monadApi',
  baseQuery: fakeBaseQuery<MonadApiError>(),
  tagTypes: [
    'Sessions',
    'Messages',
    'Agents',
    'Providers',
    'Profiles',
    'Default',
    'Roles',
    'Credentials',
    'Models',
    'InitStatus',
    'Skills',
    'SkillsSettings',
    'InstalledSkills',
    'InstalledMcp',
    'Channels',
    'AcpAgents',
    'NativeCliAgents',
    'NativeCliSessions',
    'McpServers',
    'Peers',
    'Locale',
    'Catalog',
    'Usage',
    'Stats',
    'Atoms',
    'Indexer',
    'Obscura',
    'BrowserPreset',
    'ComputerPreset',
    'OpenaiCompat',
    'ToolBackends',
    'Approvals',
    'Memory',
    'SandboxSettings',
    'NetworkSettings',
    'AppearanceSettings',
    'DeveloperSettings',
    'UserProfileSettings',
    'StartupSettings',
    'Hooks',
    'Health',
    'SystemUpgrade'
  ],
  endpoints: () => ({})
});
