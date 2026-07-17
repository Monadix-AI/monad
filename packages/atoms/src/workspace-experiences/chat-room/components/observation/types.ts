import type { CommandCardView, FileReadCardView } from '@monad/ui';
import type React from 'react';
import type { ExternalAgentStreamView } from '../../../experience/types.ts';

export type ObservationItem = ExternalAgentStreamView['items'][number];

// Neutral events carry no per-event `source`; the observed agent's `provider` is a frame-level fact,
// threaded in from the stream and used only for the card's source badge.
export type CommandToolView = CommandCardView;

export type FileReadToolView = FileReadCardView;

export type PublicObservationCard =
  | { type: 'message'; role: 'user' | 'agent'; item: ObservationItem }
  | { type: 'thinking'; item: ObservationItem }
  | { type: 'tool-pair'; call: ObservationItem; result: ObservationItem }
  | { type: 'command-tool'; view: CommandToolView }
  | { type: 'file-read-tool'; view: FileReadToolView };

export type PrivateObservationCard = {
  type: string;
  provider: string;
  item: ObservationItem;
};

type ObservationCardView =
  | { id: string; kind: 'public'; card: PublicObservationCard; timestamp?: string; raw?: unknown }
  | { id: string; kind: 'private'; card: PrivateObservationCard; timestamp?: string; raw?: unknown };

export type ObservationTimelineEntry = ObservationCardView;

export type PublicObservationCardAdapter = {
  projectItem?(item: ObservationItem, provider: string): PublicObservationCard | null;
  projectPair?(call: ObservationItem, result: ObservationItem, provider: string): PublicObservationCard | null;
};

export type PrivateObservationCardAdapter = {
  project(item: ObservationItem): PrivateObservationCard | null;
  render(card: PrivateObservationCard): React.ReactElement | null;
};
