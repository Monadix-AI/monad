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
  return item.kind === 'reasoning';
}

const thinkingCardAdapter: PublicObservationCardAdapter = {
  projectItem(item) {
    return isThinkingObservation(item) ? { type: 'thinking', item } : null;
  }
};

const commandToolCardAdapter: PublicObservationCardAdapter = {
  projectItem(item, provider) {
    const view = commandToolView(item, item, provider);
    return view ? { type: 'command-tool', view } : null;
  },
  projectPair(call, result, provider) {
    const view = commandToolView(call, result, provider);
    return view ? { type: 'command-tool', view } : null;
  }
};

const fileReadToolCardAdapter: PublicObservationCardAdapter = {
  projectPair(call, result, provider) {
    const view = fileReadToolView(call, result, provider);
    return view ? { type: 'file-read-tool', view } : null;
  }
};

const publicObservationCardAdapters: PublicObservationCardAdapter[] = [
  thinkingCardAdapter,
  fileReadToolCardAdapter,
  commandToolCardAdapter
];
const privateObservationCardAdapters: PrivateObservationCardAdapter[] = [];

export function projectPublicObservationItem(item: ObservationItem, provider: string): PublicObservationCard | null {
  for (const adapter of publicObservationCardAdapters) {
    const projected = adapter.projectItem?.(item, provider);
    if (projected) return projected;
  }
  return null;
}

export function projectPublicObservationPair(
  call: ObservationItem,
  result: ObservationItem,
  provider: string
): PublicObservationCard | null {
  for (const adapter of publicObservationCardAdapters) {
    const projected = adapter.projectPair?.(call, result, provider);
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
