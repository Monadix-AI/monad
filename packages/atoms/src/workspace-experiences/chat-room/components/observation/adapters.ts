import type {
  ObservationItem,
  PrivateObservationCard,
  PrivateObservationCardAdapter,
  PublicObservationCard,
  PublicObservationCardAdapter
} from './types.ts';

import { commandToolView } from './command-card.tsx';
import { fileReadToolView } from './file-read-card.tsx';

function isThinkingObservation(item: ObservationItem): boolean {
  const type = item.providerEventType?.toLowerCase() ?? '';
  return (
    item.role === 'agent' &&
    (type === 'thinking' ||
      type === 'reasoning' ||
      type === 'thinking_delta' ||
      type.includes('/reasoning/') ||
      type.includes('reasoning') ||
      type.includes('thinking') ||
      type === 'item/plan/delta')
  );
}

const thinkingCardAdapter: PublicObservationCardAdapter = {
  projectItem(item) {
    return isThinkingObservation(item) ? { type: 'thinking', item } : null;
  }
};

const commandToolCardAdapter: PublicObservationCardAdapter = {
  projectItem(item) {
    const view = commandToolView(item, item);
    return view ? { type: 'command-tool', view } : null;
  },
  projectPair(call, result) {
    const view = commandToolView(call, result);
    return view ? { type: 'command-tool', view } : null;
  }
};

const fileReadToolCardAdapter: PublicObservationCardAdapter = {
  projectPair(call, result) {
    const view = fileReadToolView(call, result);
    return view ? { type: 'file-read-tool', view } : null;
  }
};

const publicObservationCardAdapters: PublicObservationCardAdapter[] = [
  thinkingCardAdapter,
  commandToolCardAdapter,
  fileReadToolCardAdapter
];
const privateObservationCardAdapters: PrivateObservationCardAdapter[] = [];

export function projectPublicObservationItem(item: ObservationItem): PublicObservationCard | null {
  for (const adapter of publicObservationCardAdapters) {
    const projected = adapter.projectItem?.(item);
    if (projected) return projected;
  }
  return null;
}

export function projectPublicObservationPair(
  call: ObservationItem,
  result: ObservationItem
): PublicObservationCard | null {
  for (const adapter of publicObservationCardAdapters) {
    const projected = adapter.projectPair?.(call, result);
    if (projected) return projected;
  }
  return null;
}

export function privateObservationCard(item: ObservationItem): PrivateObservationCard | null {
  for (const adapter of privateObservationCardAdapters) {
    const projected = adapter.project(item);
    if (projected) return projected;
  }
  return null;
}

export function renderPrivateObservationCard(card: PrivateObservationCard): React.ReactElement | null {
  for (const adapter of privateObservationCardAdapters) {
    const rendered = adapter.render(card);
    if (rendered) return rendered;
  }
  return null;
}
