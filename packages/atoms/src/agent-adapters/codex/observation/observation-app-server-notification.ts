import type { ExternalAgentObservationEvent } from '@monad/protocol';
import type { CodexObservationNotification } from './index.ts';

import {
  commandText,
  numberValue,
  observation,
  providerEpochMsTimestamp,
  providerEpochSecondsTimestamp,
  rawTextValue,
  recordValue,
  textValue,
  thinkingObservation
} from '../../observation-projection.ts';
import {
  codexAppServerItemRecord,
  codexAppServerToolCallObservation,
  codexAppServerToolResultObservation,
  hasCodexAppServerToolInput,
  hasCodexAppServerToolOutput,
  isCodexAppServerToolLikeItem
} from './observation-app-server-tool.ts';
import { codexResponseItem, isCodexObservationResponseItem } from './observation-response-item.ts';

export function codexAppServerRecordEvents(
  id: string,
  record: CodexObservationNotification,
  recordIndex: number
): ExternalAgentObservationEvent[] {
  const method = record.method;
  if (!method) return [];
  const params =
    record.params && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params : {};
  const p = params as Record<string, unknown>;
  if (method === 'thread/started') {
    const thread = p.thread && typeof p.thread === 'object' && !Array.isArray(p.thread) ? p.thread : {};
    const cwd = textValue((thread as Record<string, unknown>).cwd);
    return observation({
      id: `${id}:json:${recordIndex}:thread-started`,
      role: 'system',
      text: cwd ? `Thread started in ${cwd}` : 'Thread started',
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'mcpServer/startupStatus/updated') {
    const name = textValue(p.name) ?? 'MCP server';
    const status = textValue(p.status) ?? 'updated';
    const error = textValue(p.error);
    return observation({
      id: `${id}:json:${recordIndex}:mcp-status`,
      role: error ? 'system' : 'tool',
      text: error ? `${name} ${status}: ${error}` : `${name} ${status}`,
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'rawResponseItem/completed') {
    const item = p.item;
    return isCodexObservationResponseItem(item)
      ? codexResponseItem(id, item, recordIndex, 'codex-app-server', record)
      : [];
  }
  if (method === 'account/rateLimits/updated') {
    return observation({
      id: `${id}:json:${recordIndex}:rate-limits`,
      role: 'system',
      text: 'Usage limits updated',
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'thread/tokenUsage/updated') {
    return observation({
      id: `${id}:json:${recordIndex}:token-usage`,
      role: 'system',
      text: 'Token usage updated',
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'item/started') {
    const item = codexAppServerItemRecord(p);
    if (!item) return [];
    if (!isCodexAppServerToolLikeItem(item)) return [];
    return codexAppServerToolCallObservation({
      id,
      recordIndex,
      method,
      record,
      item,
      createdAt: providerEpochMsTimestamp(numberValue(p.startedAtMs))
    });
  }
  if (method === 'item/completed') {
    const item = codexAppServerItemRecord(p);
    if (!item) return [];
    const createdAt = providerEpochMsTimestamp(numberValue(p.completedAtMs));
    const itemType = textValue(item.type);
    if (itemType === 'contextCompaction') {
      return observation({
        id: `${id}:json:${recordIndex}:context-compaction`,
        role: 'system',
        text: 'Context compacted',
        source: 'codex-app-server',
        providerEventType: 'contextCompaction',
        createdAt,
        raw: record
      });
    }
    if (isCodexObservationResponseItem(item)) {
      const responseItem = codexResponseItem(id, item, recordIndex, 'codex-app-server', record, createdAt);
      if (responseItem.length > 0) return responseItem;
    }
    if (!isCodexAppServerToolLikeItem(item)) return [];
    if (!hasCodexAppServerToolOutput(item)) {
      return codexAppServerToolCallObservation({ id, recordIndex, method, record, item, createdAt });
    }
    const result = codexAppServerToolResultObservation({ id, recordIndex, method, record, item, createdAt });
    return hasCodexAppServerToolInput(item)
      ? [...codexAppServerToolCallObservation({ id, recordIndex, method, record, item, createdAt }), ...result]
      : result;
  }
  if (
    method === 'item/commandExecution/outputDelta' ||
    method === 'command/exec/outputDelta' ||
    method === 'process/outputDelta' ||
    method === 'item/fileChange/outputDelta' ||
    method === 'item/mcpToolCall/progress'
  ) {
    return observation({
      id: `${id}:json:${recordIndex}:tool-delta`,
      role: 'tool',
      text: rawTextValue(p.delta, p.output, p.text, p.message),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (method === 'item/agentMessage/delta') {
    return observation({
      id: `${id}:json:${recordIndex}:agent-delta`,
      role: 'agent',
      text: rawTextValue(p.delta, p.text),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/reasoning/textDelta' ||
    method === 'item/plan/delta'
  ) {
    return thinkingObservation({
      id: `${id}:json:${recordIndex}:reasoning-delta`,
      text: rawTextValue(p.delta, p.text),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (method === 'turn/diff/updated') {
    return observation({
      id: `${id}:json:${recordIndex}:diff`,
      role: 'tool',
      text: rawTextValue(p.diff, p.unifiedDiff),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (method === 'turn/started' || method === 'turn/completed' || method === 'thread/status/changed') {
    const turn = recordValue(p.turn);
    const createdAt =
      method === 'turn/started'
        ? providerEpochSecondsTimestamp(numberValue(turn?.startedAt))
        : method === 'turn/completed'
          ? providerEpochSecondsTimestamp(numberValue(turn?.completedAt))
          : undefined;
    return observation({
      id: `${id}:json:${recordIndex}:status`,
      role: 'system',
      text: textValue(p.status, p.type) ?? method,
      source: 'codex-app-server',
      providerEventType: method,
      createdAt,
      raw: record
    });
  }
  if (method.includes('Approval') || method.includes('approval')) {
    const command = commandText(p.command);
    const reason = textValue(p.reason);
    return observation({
      id: `${id}:json:${recordIndex}:approval`,
      role: 'tool',
      text: `Approval requested: ${command ?? reason ?? method}`,
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  return [];
}
