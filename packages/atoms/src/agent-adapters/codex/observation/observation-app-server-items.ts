import type { MeshAgentObservationEvent } from '@monad/protocol';

import {
  numberValue,
  observation,
  providerEpochMsTimestamp,
  recordValue,
  textValue
} from '../../observation-projection.ts';
import {
  codexAppServerToolCallObservation,
  codexAppServerToolResultObservation,
  hasCodexAppServerToolInput,
  hasCodexAppServerToolOutput,
  isCodexAppServerToolLikeItem
} from './observation-app-server-tool.ts';
import { codexItemText } from './observation-message-group.ts';
import { codexResponseItem, isCodexObservationResponseItem } from './observation-response-item.ts';

function codexAppServerItemEvents(args: {
  id: string;
  record: unknown;
  item: Record<string, unknown>;
  itemIndex?: number;
  recordIndex: number;
}): MeshAgentObservationEvent[] {
  const type = textValue(args.item.type);
  const itemIndex = args.itemIndex === undefined ? '' : `:${args.itemIndex}`;
  const createdAt = providerEpochMsTimestamp(
    numberValue(args.item.completedAtMs, args.item.startedAtMs, args.item.createdAtMs, args.item.updatedAtMs)
  );
  if (type === 'agentMessage' || type === 'userMessage') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}${itemIndex}:${type}`,
      role: type === 'userMessage' ? 'user' : 'agent',
      text: codexItemText(args.item),
      source: 'codex-app-server',
      providerEventType: `item/${type}`,
      createdAt,
      raw: args.item
    });
  }
  if (type === 'contextCompaction') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}${itemIndex}:context-compaction`,
      role: 'system',
      text: 'Context compacted',
      source: 'codex-app-server',
      providerEventType: 'contextCompaction',
      createdAt,
      raw: args.item
    });
  }
  if (isCodexObservationResponseItem(args.item)) {
    const responseItem = codexResponseItem(
      args.id,
      args.item,
      args.itemIndex ?? args.recordIndex,
      'codex-app-server',
      args.item,
      createdAt
    );
    if (responseItem.length > 0) return responseItem;
  }
  if (!isCodexAppServerToolLikeItem(args.item)) return [];
  const hasInput = hasCodexAppServerToolInput(args.item);
  const hasOutput = hasCodexAppServerToolOutput(args.item);
  if (hasOutput) {
    const result = codexAppServerToolResultObservation({
      id: args.id,
      recordIndex: args.recordIndex,
      itemIndex: args.itemIndex,
      method: 'item/completed',
      record: args.item,
      item: args.item,
      createdAt
    });
    return hasInput
      ? [
          ...codexAppServerToolCallObservation({
            id: args.id,
            recordIndex: args.recordIndex,
            method: 'item/completed',
            record: args.item,
            item: args.item,
            createdAt
          }),
          ...result
        ]
      : result;
  }
  return codexAppServerToolCallObservation({
    id: args.id,
    recordIndex: args.recordIndex,
    method: 'item/started',
    record: args.item,
    item: args.item,
    createdAt
  });
}

export function codexAppServerBatchRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  if (!Array.isArray(record.items)) return [];
  return record.items.flatMap((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    return codexAppServerItemEvents({
      id,
      record,
      item: item as Record<string, unknown>,
      itemIndex,
      recordIndex
    });
  });
}

export function codexAppServerTurnsPageRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const result = recordValue(record.result);
  if (!result || !Array.isArray(result.data)) return [];
  let itemOffset = 0;
  return result.data.flatMap((turn) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return [];
    const items = (turn as Record<string, unknown>).items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const currentItemIndex = itemOffset;
      itemOffset += 1;
      return codexAppServerItemEvents({
        id,
        record,
        item: item as Record<string, unknown>,
        itemIndex: currentItemIndex,
        recordIndex
      });
    });
  });
}
