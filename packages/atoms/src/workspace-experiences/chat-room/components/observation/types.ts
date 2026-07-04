import type React from 'react';
import type { NativeCliStreamView } from '../../../project/types.ts';

export type ObservationItem = NativeCliStreamView['items'][number];

export type CommandToolView = {
  type: string;
  source: ObservationItem['source'];
  command: string;
  cwd?: string;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
};

export type FileReadToolView = {
  type: string;
  source: ObservationItem['source'];
  path: string;
  content: string;
};

export type PublicObservationCard =
  | { type: 'message'; role: ObservationItem['role']; item: ObservationItem }
  | { type: 'tool-pair'; call: ObservationItem; result: ObservationItem }
  | { type: 'command-tool'; view: CommandToolView }
  | { type: 'file-read-tool'; view: FileReadToolView };

export type PrivateObservationCard = {
  type: `${ObservationItem['source']}:${string}`;
  source: ObservationItem['source'];
  item: ObservationItem;
};

type ObservationCardView =
  | { id: string; kind: 'public'; card: PublicObservationCard; timestamp?: string; raw?: unknown }
  | { id: string; kind: 'private'; card: PrivateObservationCard; timestamp?: string; raw?: unknown };

export type ObservationTimelineEntry = ObservationCardView;

export type PublicObservationCardAdapter = {
  projectItem?(item: ObservationItem): PublicObservationCard | null;
  projectPair?(call: ObservationItem, result: ObservationItem): PublicObservationCard | null;
};

export type PrivateObservationCardAdapter = {
  project(item: ObservationItem): PrivateObservationCard | null;
  render(card: PrivateObservationCard): React.ReactElement | null;
};
