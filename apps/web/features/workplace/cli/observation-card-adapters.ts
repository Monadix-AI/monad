import type {
  ObservationItem,
  PrivateObservationCard,
  PrivateObservationCardAdapter,
  PublicObservationCard,
  PublicObservationCardAdapter
} from './observation-card-types';

import { commandToolView } from './observation-command-card';
import { fileReadToolView } from './observation-file-read-card';

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

const publicObservationCardAdapters: PublicObservationCardAdapter[] = [commandToolCardAdapter, fileReadToolCardAdapter];
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
