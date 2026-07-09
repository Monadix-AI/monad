import type { ModelInfo } from '@monad/protocol';
import type { ComponentType } from 'react';

export interface DraftKey {
  id: string;
  accessToken: string;
  saved?: boolean;
}

export interface DraftProvider {
  type: string;
  id: string;
  baseUrl?: string;
  extra?: Record<string, string>;
  keys: DraftKey[];
  models: ModelInfo[];
}

export interface InitProviderMeta {
  color?: string;
  label?: string;
  logo?: ComponentType<{ className?: string }>;
}
