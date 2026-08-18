import type { AgentObservationEvent } from '@monad/protocol';
import type { AgentObservationCard } from '../../../../agent-adapters/observation-cards.ts';
import type { ObservationTimelineRow } from './timeline.tsx';

import { observationTimelineEntries, observationTimelineRows } from './timeline.tsx';

export type ObservationTurnTimelineItem = { id: string; row: ObservationTimelineRow };

type ObservationTurnGroup = {
  body: AgentObservationCard[];
  completedAt?: string;
  startedAt?: string;
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

function cardsWithTurnMessageTimestamps(group: ObservationTurnGroup): AgentObservationCard[] {
  return group.body.map((card) => {
    const event = eventFromCard(card);
    if (!event || event.at || card.at) return card;
    const at =
      event.kind === 'user-message'
        ? group.startedAt
        : event.kind === 'assistant-message'
          ? (group.completedAt ?? group.startedAt)
          : undefined;
    return at ? { ...card, at } : card;
  });
}

/**
 * A delta-derived card carries `streaming: true` for as long as the projector sees it as a streaming
 * fragment — the provider never sends a "that run ended" frame, so the flag alone never clears. The
 * timeline settles it positionally, but it does so per turn group, which leaves a finished turn's
 * trailing reasoning card running forever while a LATER turn is active. Anything a card produced
 * before the newest one is finished by definition, so settle it here, across the whole timeline.
 */
function settleSupersededStreams(cards: readonly AgentObservationCard[]): readonly AgentObservationCard[] {
  const settleable = (card: AgentObservationCard) => card.kind === 'reasoning' || card.kind === 'message';
  let lastStreamable = -1;
  for (const [index, card] of cards.entries()) {
    if (card.kind !== 'system' && card.kind !== 'unknown') lastStreamable = index;
  }
  if (!cards.some((card, index) => index !== lastStreamable && card.streaming && settleable(card))) return cards;
  return cards.map((card, index) =>
    index !== lastStreamable && card.streaming && settleable(card) ? { ...card, streaming: false } : card
  );
}

export function observationTurnTimelineItems(
  allCards: readonly AgentObservationCard[],
  provider: string,
  active = false
): ObservationTurnTimelineItem[] {
  const cards = settleSupersededStreams(allCards);
  const items: ObservationTurnTimelineItem[] = [];
  let ungrouped: AgentObservationCard[] = [];
  let current: ObservationTurnGroup | undefined;

  const flushUngrouped = () => {
    items.push(...activityItems(ungrouped, provider, active));
    ungrouped = [];
  };
  const flushTurn = () => {
    if (!current) return;
    items.push(...activityItems(cardsWithTurnMessageTimestamps(current), provider, active));
    current = undefined;
  };

  for (const card of cards) {
    const kind = eventFromCard(card)?.kind;
    if (kind === 'turn-start') {
      flushUngrouped();
      flushTurn();
      current = { body: [], startedAt: eventFromCard(card)?.at };
      continue;
    }
    if (kind === 'turn-end') {
      if (current) current.completedAt = eventFromCard(card)?.at;
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
