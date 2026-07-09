import type { ModelInfo } from '@monad/protocol';

import { ModelHoverCardBody } from '../model-picker';

export const MODEL_CATEGORY_TABS = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Text' },
  { id: 'image', label: 'Image' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'audio', label: 'Audio' },
  { id: 'video', label: 'Video' },
  { id: 'rerank', label: 'Rerank' },
  { id: 'speech', label: 'Speech' },
  { id: 'transcription', label: 'Transcription' }
] as const;

export type ModelCategoryTabId = (typeof MODEL_CATEGORY_TABS)[number]['id'];

function modelOutputs(model: ModelInfo): string[] {
  const output = model.modalities?.output?.filter((item) => item.length > 0) ?? [];
  if (output.length > 0) return output;
  switch (model.modalities?.kind) {
    case 'embedding':
      return ['embeddings'];
    case 'image':
    case 'video':
    case 'speech':
    case 'audio':
    case 'rerank':
    case 'transcription':
      return [model.modalities.kind];
    default:
      return ['text'];
  }
}

export function modelMatchesCategory(model: ModelInfo, category: ModelCategoryTabId): boolean {
  if (category === 'all') return true;
  const output = modelOutputs(model);
  if (category === 'embeddings') return output.includes('embeddings') || output.includes('embedding');
  return output.includes(category);
}

export function categoryCounts(models: ModelInfo[]): Record<ModelCategoryTabId, number> {
  return Object.fromEntries(
    MODEL_CATEGORY_TABS.map((tab) => [tab.id, models.filter((model) => modelMatchesCategory(model, tab.id)).length])
  ) as Record<ModelCategoryTabId, number>;
}

function ProviderModelCard({ model }: { model: ModelInfo }) {
  return (
    <div className="glass-foreground min-w-0 rounded-(--radius-sm) border border-border/60 p-3">
      <ModelHoverCardBody model={model} />
    </div>
  );
}

export function ProviderModelGrid({ models }: { models: ModelInfo[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {models.map((model) => (
        <ProviderModelCard
          key={model.id}
          model={model}
        />
      ))}
    </div>
  );
}
