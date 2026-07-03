export type {
  ClientRequest as CodexAppServerClientRequest,
  ResponseItem as CodexAppServerResponseItem,
  ServerNotification as CodexAppServerNotification,
  ServerRequest as CodexAppServerServerRequest
} from '../vendor/codex-app-server/ts/index.ts';

import type {
  ServerNotification as CodexAppServerNotification,
  ServerRequest as CodexAppServerServerRequest
} from '../vendor/codex-app-server/ts/index.ts';

export type {
  ThreadListResponse as CodexAppServerThreadListResponse,
  ThreadReadResponse as CodexAppServerThreadReadResponse,
  TurnsPage as CodexAppServerTurnsPage
} from '../vendor/codex-app-server/ts/v2/index.ts';

export type CodexAppServerMethod =
  | CodexAppServerNotification['method']
  | CodexAppServerServerRequest['method']
  | 'turn/failed';

export const codexAppServerObservationMethods = [
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'turn/failed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'rawResponseItem/completed',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'serverRequest/resolved',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
  'thread/tokenUsage/updated',
  'error',
  'warning',
  'guardianWarning',
  'configWarning',
  'deprecationNotice'
] as const satisfies readonly CodexAppServerMethod[];

const codexAppServerObservationMethodSet = new Set<string>(codexAppServerObservationMethods);

export function isCodexAppServerObservationMethod(method: string): method is CodexAppServerMethod {
  return codexAppServerObservationMethodSet.has(method);
}
