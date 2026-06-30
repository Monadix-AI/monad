import type {
  NativeCliAgentPresetView,
  NativeCliAgentView,
  NativeCliAuthState,
  NativeCliHistoryPageRequest,
  NativeCliLaunchMode,
  NativeCliProvider
} from '@monad/protocol';
import type { BinProbes } from '@/infra/resolve-binary.ts';

import { z } from 'zod';

type NativeCliCapability =
  | NativeCliLaunchMode
  | 'provider-approval'
  | 'approval-resolution'
  | 'structured-output'
  | 'session-resume'
  | 'rollout-json-fallback';

export interface NativeCliLaunchSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  launchMode: NativeCliLaunchMode;
  provider: NativeCliProvider;
  approvalOwnership: 'provider-owned';
  capabilities: NativeCliCapability[];
}

export type NativeCliStartPreflight =
  | { state: 'ready'; agentName: string; provider: NativeCliProvider; checkedAt: string; providerSessionRef?: string }
  | {
      state: 'not_authenticated';
      agentName: string;
      provider: NativeCliProvider;
      checkedAt: string;
      action: 'reconnect_in_studio';
      reason: string;
    }
  | {
      state: 'unavailable';
      agentName: string;
      provider: NativeCliProvider;
      checkedAt: string;
      reason: string;
    }
  | {
      state: 'unknown';
      agentName: string;
      provider: NativeCliProvider;
      checkedAt: string;
      action: 'manual_check_in_studio';
      reason: string;
    };

export interface BuildNativeCliLaunchOptions {
  workingPath: string;
  launchMode?: NativeCliLaunchMode;
  providerSessionRef?: string;
}

export interface NativeCliOutputEvent {
  type:
    | 'approval_requested'
    | 'approval_resolved'
    | 'agent_message'
    | 'connection_required'
    | 'history_page'
    | 'session_ref'
    | 'tool_call'
    | 'tool_result'
    | 'web_search_result';
  payload: Record<string, unknown>;
}

const requestIdSchema = z.union([z.string().min(1), z.number()]);
const nativeCliOutputPayloadBase = z.object({}).catchall(z.unknown());

export const nativeCliOutputEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_ref'),
    payload: nativeCliOutputPayloadBase.extend({
      providerSessionRef: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('agent_message'),
    payload: nativeCliOutputPayloadBase.extend({
      text: z.string()
    })
  }),
  z.object({
    type: z.literal('tool_call'),
    payload: nativeCliOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      tool: z.string().min(1).optional(),
      input: z.unknown().optional()
    })
  }),
  z.object({
    type: z.literal('tool_result'),
    payload: nativeCliOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      output: z.unknown().optional()
    })
  }),
  z.object({
    type: z.literal('web_search_result'),
    payload: nativeCliOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      status: z.string().optional()
    })
  }),
  z.object({
    type: z.literal('connection_required'),
    payload: nativeCliOutputPayloadBase.extend({
      code: z.string().min(1).optional(),
      reason: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('history_page'),
    payload: nativeCliOutputPayloadBase.extend({
      responseId: z.union([z.string().min(1), z.number()]),
      items: z.array(z.unknown()),
      nextCursor: z.string().nullable(),
      backwardsCursor: z.string().nullable()
    })
  }),
  z.object({
    type: z.literal('approval_requested'),
    payload: nativeCliOutputPayloadBase.extend({
      requestId: requestIdSchema,
      kind: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('approval_resolved'),
    payload: nativeCliOutputPayloadBase.extend({
      requestId: requestIdSchema
    })
  })
]);

export interface NativeCliRuntimeHandle {
  terminal?: {
    write(input: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
  };
  stdin?: {
    write(input: string): void;
    flush?(): void | Promise<void>;
    end?(): void | Promise<void>;
  };
  launchMode?: NativeCliLaunchMode;
  providerSessionRef?: string | null;
  nextRequestId?(): number;
  kill(signal?: NodeJS.Signals): void;
}

interface NativeCliApprovalResolution {
  requestId: string;
  allow: boolean;
  reason?: string;
  request?: Record<string, unknown>;
}

interface NativeCliInitializeContext {
  workingPath: string;
  providerSessionRef?: string;
}

export interface NativeCliProviderAdapter {
  provider: NativeCliProvider;
  detect(probes?: BinProbes): NativeCliAgentPresetView;
  resolveCommand?(command: string, probes?: BinProbes): string | undefined;
  buildLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec;
  buildAuthLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec;
  buildAuthStatusLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec;
  parseAuthStatus(output: string, exitCode: number | null): NativeCliAuthState;
  requestHistoryPage?(handle: NativeCliRuntimeHandle, request: NativeCliHistoryPageRequest): string | number;
  initialize?(handle: NativeCliRuntimeHandle, context: NativeCliInitializeContext): void;
  parseOutput(chunk: string): NativeCliOutputEvent[];
  sendInput(handle: NativeCliRuntimeHandle, input: string): void;
  resolveApproval(handle: NativeCliRuntimeHandle, resolution: NativeCliApprovalResolution): void;
  resize(handle: NativeCliRuntimeHandle, cols: number, rows: number): void;
  stop(handle: NativeCliRuntimeHandle): void;
}
