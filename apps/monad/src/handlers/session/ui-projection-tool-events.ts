import type { Event, SessionUiEvent, UIItem } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { parseEventPayload } from '@monad/protocol';

import { findNativeCliProviderAdapter } from '@/services/native-cli/index.ts';
import {
  appendBoundedText,
  isUnknownToolResult,
  itemKey,
  MAX_NATIVE_CLI_UI_OUTPUT,
  nativeCliProviderFromToolItem,
  nativeCliSnapshotIsGenerating
} from './ui-projection-helpers.ts';

export function applyToolEvent(m: ProjectionMutations, event: Event): SessionUiEvent[] | undefined {
  switch (event.type) {
    case 'tool.called': {
      const p = parseEventPayload('tool.called', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'tool',
            id: p.toolCallId,
            tool: p.tool,
            ...(p.input !== undefined ? { input: p.input } : {}),
            status: 'running',
            seq: event.id
          })
        }
      ];
    }
    case 'tool.result': {
      const p = parseEventPayload('tool.result', event.payload);
      if (!p.ok && isUnknownToolResult(p.tool, p.result)) return [m.remove('tool', p.toolCallId)];
      const existing = m.items.get(itemKey('tool', p.toolCallId));
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.toolCallId,
        tool: existing?.kind === 'tool' ? existing.tool : 'tool',
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        ...((p.displayResult ?? p.result) ? { output: p.displayResult ?? p.result } : {}),
        ...('display' in p ? { display: p.display } : {}),
        status: p.ok ? 'ok' : 'error',
        seq: existing?.kind === 'tool' ? existing.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'tool.progress': {
      const p = parseEventPayload('tool.progress', event.payload);
      const existing = m.items.get(itemKey('tool', p.toolCallId));
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.toolCallId,
        tool: existing?.kind === 'tool' ? existing.tool : p.tool,
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        output: `${existing?.kind === 'tool' && existing.output ? `${existing.output}\n` : ''}${p.output}`,
        status: 'running',
        seq: existing?.kind === 'tool' ? existing.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'native_cli.started': {
      const p = parseEventPayload('native_cli.started', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'tool',
            id: p.nativeCliSessionId,
            tool: `native-cli:${p.provider}`,
            input: {
              agent: p.agentName,
              provider: p.provider,
              productIcon: p.productIcon,
              workingPath: p.workingPath,
              launchMode: p.launchMode,
              approvalOwnership: 'provider-owned'
            },
            status: 'running',
            seq: event.id
          })
        }
      ];
    }
    case 'native_cli.output': {
      const p = parseEventPayload('native_cli.output', event.payload);
      const existing = m.items.get(itemKey('tool', p.nativeCliSessionId));
      const existingTool = existing?.kind === 'tool' ? existing : undefined;
      const output = existingTool
        ? appendBoundedText(existingTool.output ?? '', p.chunk, MAX_NATIVE_CLI_UI_OUTPUT)
        : p.chunk;
      const provider = nativeCliProviderFromToolItem(existingTool);
      const generating = provider === undefined ? undefined : nativeCliSnapshotIsGenerating(output, provider);
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.nativeCliSessionId,
        tool: existingTool ? existingTool.tool : 'native-cli',
        ...(existingTool?.input !== undefined ? { input: existingTool.input } : {}),
        output,
        status:
          generating === undefined ? (existingTool ? existingTool.status : 'running') : generating ? 'running' : 'ok',
        seq: existingTool ? existingTool.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'native_cli.connection_required': {
      const p = parseEventPayload('native_cli.connection_required', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'custom',
            id: `native-cli-connection-required:${p.nativeCliSessionId ?? p.agentName}`,
            name: 'native_cli.connection_required',
            status: 'error',
            data: p,
            seq: event.id
          })
        }
      ];
    }
    case 'native_cli.approval_requested': {
      const p = parseEventPayload('native_cli.approval_requested', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'approval',
            id: p.requestId,
            tool: `${p.provider} approval`,
            input: {
              nativeCliSessionId: p.nativeCliSessionId,
              provider: p.provider,
              text: p.text,
              data: p.data,
              approvalOwnership: 'provider-owned'
            },
            key: `provider-owned:${p.provider}`,
            seq: event.id
          })
        }
      ];
    }
    case 'native_cli.approval_resolved': {
      const p = parseEventPayload('native_cli.approval_resolved', event.payload);
      return [m.remove('approval', p.requestId)];
    }
    case 'native_cli.resume_failed': {
      const p = parseEventPayload('native_cli.resume_failed', event.payload);
      const label = findNativeCliProviderAdapter(p.provider)?.label ?? p.provider;
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'system',
            id: `native-cli-resume-failed:${p.agentName}:${p.providerSessionRef}`,
            text: `${label} resume failed for provider session ${p.providerSessionRef}; cold started a new runtime.`,
            level: 'warn',
            seq: event.id
          })
        }
      ];
    }
    case 'native_cli.exited': {
      const p = parseEventPayload('native_cli.exited', event.payload);
      const existing = m.items.get(itemKey('tool', p.nativeCliSessionId));
      const exitText = p.exitCode === null ? `\n${p.state}` : `\n${p.state} (${p.exitCode})`;
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.nativeCliSessionId,
        tool: existing?.kind === 'tool' ? existing.tool : 'native-cli',
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        output: `${existing?.kind === 'tool' && existing.output ? existing.output : ''}${exitText}`,
        status: p.state === 'failed' ? 'error' : 'ok',
        seq: existing?.kind === 'tool' ? existing.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    default:
      return undefined;
  }
}
