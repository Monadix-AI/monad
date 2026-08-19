import type { MeshAgentObservationEvent } from '@monad/protocol';
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
  thinkingObservation,
  turnEndReasonFromStopValue
} from '../../shared/observation/observation-projection.ts';
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
): MeshAgentObservationEvent[] {
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
    const detail = textValue(p.error) ?? textValue(p.failureReason);
    return observation({
      id: `${id}:json:${recordIndex}:mcp-status`,
      projection: 'unknown',
      role: 'system',
      text: detail ? `${name} ${status}: ${detail}` : `${name} ${status}`,
      source: 'codex-app-server',
      providerEventType: method,
      progress: {
        kind: 'mcp-startup',
        servers: [
          {
            name,
            status,
            ...(textValue(p.error) ? { error: textValue(p.error) as string } : {}),
            ...(textValue(p.failureReason) ? { failureReason: textValue(p.failureReason) as string } : {})
          }
        ],
        ...(textValue(p.threadId) ? { scopeId: textValue(p.threadId) as string } : {})
      },
      raw: record
    });
  }
  if (method === 'turn/plan/updated') {
    const steps = codexPlanSteps(p.plan);
    if (steps.length === 0) return [];
    const done = steps.filter((step) => step.status === 'completed').length;
    const active = steps.find((step) => step.status === 'inProgress')?.step;
    return observation({
      id: `${id}:json:${recordIndex}:plan`,
      projection: 'unknown',
      role: 'system',
      text: active ? `Plan ${done}/${steps.length}: ${active}` : `Plan ${done}/${steps.length}`,
      source: 'codex-app-server',
      providerEventType: method,
      progress: {
        kind: 'plan',
        steps: steps as [(typeof steps)[number], ...(typeof steps)[number][]],
        ...(textValue(p.turnId) ? { scopeId: textValue(p.turnId) as string } : {})
      },
      raw: record
    });
  }
  if (method === 'error') {
    const error = recordValue(p.error);
    const message = textValue(error?.message) ?? 'Codex reported an error';
    const detail = textValue(error?.additionalDetails);
    return observation({
      id: `${id}:json:${recordIndex}:error`,
      role: 'system',
      text: message,
      diagnostic: {
        severity: p.willRetry === true ? 'warning' : 'error',
        message,
        ...(detail ? { detail } : {})
      },
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'hook/completed') {
    // Hooks run on every turn and almost always succeed; only a failed run is worth a card.
    const run = recordValue(p.run);
    const status = textValue(run?.status);
    if (!status || status === 'completed') return [];
    const name = textValue(run?.eventName) ?? 'hook';
    const detail = textValue(run?.statusMessage, run?.sourcePath);
    return observation({
      id: `${id}:json:${recordIndex}:hook`,
      role: 'system',
      text: `Hook ${name} ${status}`,
      diagnostic: {
        severity: 'warning',
        message: `Hook ${name} ${status}`,
        ...(detail ? { detail } : {})
      },
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
    // A delta frame carries no item, only `itemId` — and that id must match the one the call and
    // result declare, or the delta renders as its own card instead of streaming into the command's.
    const deltaCallId = textValue(p.itemId, p.callId, p.call_id);
    return observation({
      id: `${id}:json:${recordIndex}:tool-delta`,
      role: 'tool',
      text: rawTextValue(p.delta, p.output, p.text, p.message),
      source: 'codex-app-server',
      providerEventType: method,
      ...(deltaCallId ? { tool: { callId: deltaCallId, status: 'running' as const } } : {}),
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
    // Turn diffs are cumulative snapshots retained by the raw view; item/fileChange owns public edit cards.
    return [];
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
      turnEndReason: turnEndReasonFromStopValue(recordValue(p.error) ? 'error' : undefined, p.reason, turn?.status),
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

function codexPlanSteps(value: unknown): { step: string; status: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = recordValue(entry);
    const step = textValue(record?.step);
    return step ? [{ step, status: textValue(record?.status) ?? 'pending' }] : [];
  });
}

const CODEX_LIVE_APP_SERVER_EVENT_METHODS = new Map([
  ['thread.started', 'thread/started'],
  ['turn.started', 'turn/started'],
  ['turn.completed', 'turn/completed'],
  ['thread.status.changed', 'thread/status/changed'],
  ['item.started', 'item/started'],
  ['item.completed', 'item/completed'],
  ['item.agentMessage.delta', 'item/agentMessage/delta'],
  ['item.reasoning.summaryTextDelta', 'item/reasoning/summaryTextDelta'],
  ['item.reasoning.textDelta', 'item/reasoning/textDelta'],
  ['item.plan.delta', 'item/plan/delta'],
  ['item.commandExecution.outputDelta', 'item/commandExecution/outputDelta'],
  ['command.exec.outputDelta', 'command/exec/outputDelta'],
  ['process.outputDelta', 'process/outputDelta'],
  ['item.fileChange.outputDelta', 'item/fileChange/outputDelta'],
  ['item.mcpToolCall.progress', 'item/mcpToolCall/progress'],
  ['turn.diff.updated', 'turn/diff/updated']
]);

export function isCodexLiveAppServerRecord(record: Record<string, unknown>): boolean {
  const type = textValue(record.type);
  return type ? CODEX_LIVE_APP_SERVER_EVENT_METHODS.has(type) : false;
}

export function codexLiveAppServerRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const type = textValue(record.type);
  const method = type ? CODEX_LIVE_APP_SERVER_EVENT_METHODS.get(type) : undefined;
  if (!method) return [];
  const { type: _type, ...params } = record;
  return codexAppServerRecordEvents(id, { method, params }, recordIndex);
}
