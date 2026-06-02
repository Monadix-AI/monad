import type { AgentObservationEvent } from '@monad/protocol';
import type { AgentObservationCard } from '../../../../agent-adapters/observation-cards.ts';
import type { ObservationTimelineRow } from './timeline.tsx';

import { observationTimelineEntries, observationTimelineRows } from './timeline.tsx';

export type ObservationTurnTimelineItem = { id: string; row: ObservationTimelineRow };

type ObservationTurnGroup = {
  body: AgentObservationCard[];
};

function eventFromCard(card: AgentObservationCard): AgentObservationEvent | undefined {
  const event = card.payload.event ?? card.payload.call ?? card.payload.result;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as AgentObservationEvent) : undefined;
}

function activityItems(
  cards: readonly AgentObservationCard[],
  provider: string,
  active: boolean
): ObservationTurnTimelineItem[] {
  return observationTimelineRows(observationTimelineEntries(cards, provider, active)).map((row) => ({
    id: row.id,
    row
  }));
}

export function observationTurnTimelineItems(
  cards: readonly AgentObservationCard[],
  provider: string,
  active = false
): ObservationTurnTimelineItem[] {
  const items: ObservationTurnTimelineItem[] = [];
  let ungrouped: AgentObservationCard[] = [];
  let current: ObservationTurnGroup | undefined;

  const flushUngrouped = () => {
    items.push(...activityItems(ungrouped, provider, active));
    ungrouped = [];
  };
  const flushTurn = () => {
    if (!current) return;
    items.push(...activityItems(current.body, provider, active));
    current = undefined;
  };

  for (const card of cards) {
    const kind = eventFromCard(card)?.kind;
    if (kind === 'turn-start') {
      flushUngrouped();
      flushTurn();
      current = { body: [] };
      continue;
    }
    if (kind === 'turn-end') {
      flushTurn();
      continue;
    }
    if (current) current.body.push(card);
    else ungrouped.push(card);
  }

  flushTurn();
  flushUngrouped();
  return items;
}
