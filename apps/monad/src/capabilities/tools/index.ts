// @/capabilities/tools — built-in tool atoms. Each tool declares the scopes it needs and
// whether it is high-risk. Resource-specific guards live in the tool run() bodies —
// see security.ts and docs/security-guidelines.md §4.

export { configureShell, createSandboxBackends, isDelegableTool } from './backends.ts';
export {
  CodeExecError,
  codeExecTool,
  configureCodeExec,
  configureHostExec,
  detectDockerRuntime,
  followSystemBackend,
  selectCodeExecBackend
} from './registry/code-exec.ts';
export {
  configureEmail,
  emailSendTool
} from './registry/email/index.ts';
export { fileGlobTool, fileGrepTool, filePatchTool, fileReadTool, fileWriteTool } from './registry/fs.ts';
// builtinTools (static tier) + the service-tier composer are assembled in the registry manifest
// (registry/index.ts) from each module's uniform `register` entry.
export { buildServiceTools, builtinTools } from './registry/index.ts';
export {
  connectMcpServer,
  type McpConnection,
  type McpHttpAuth,
  type McpServerSpec
} from './registry/mcp/index.ts';
export {
  canonicalResourceUri,
  defaultResourceMetadataUrl,
  discoverAuthServer,
  discoverProtectedResource,
  McpOAuthError,
  pollDeviceToken,
  type StoredOAuth,
  startDeviceAuthorization
} from './registry/mcp/oauth.ts';
export { netFetchTool } from './registry/net.ts';
export {
  clearProcesses,
  clearProcessesForSession,
  processKillTool,
  processListTool,
  processLogsTool,
  processResizeTool,
  processSignalTool,
  processStartTool,
  processWaitTool,
  processWriteTool
} from './registry/process.ts';
export { shellArgv, shellExecTool } from './registry/shell.ts';
export { clearTodos, type TodoItem, todoReadTool, todoWriteTool } from './registry/todo.ts';
export { extractReadable, webExtractTool } from './registry/web-extract.ts';
export {
  configureWebSearch,
  createBraveProvider,
  duckDuckGoProvider,
  parseDuckDuckGoHtml,
  selectProvider,
  WebSearchError
} from './registry/web-search.ts';
// Sandbox launchers (seatbelt/landlock/win32/bwrap) are the `sandbox` atom kind — they live in
export {
  domainMatches,
  type EgressPolicy,
  isEgressAllowed,
  normalizeHost
} from './sandbox/egress-policy.ts';
export {
  clearSandboxLaunchers,
  disposeSandboxSession,
  registerSandboxLauncher,
  selectSandboxLauncher
} from './sandbox/registry.ts';
export {
  createSessionSandbox,
  disposeSessionSandbox,
  sandboxDirName,
  sessionSandboxPath,
  sweepOrphanSandboxes
} from './sandbox/session-root.ts';
export {
  buildSandboxPolicy,
  configureSandboxExtraEnv,
  configureSandboxLauncher,
  configureSandboxNet,
  configureSandboxProxyEnv,
  configureSandboxReadDeny,
  noneLauncher,
  type SandboxLauncher,
  type SandboxPolicy,
  sandboxedSpawn,
  sandboxHomeEnv,
  sandboxLauncher
} from './sandbox/spawn.ts';
export { assertPathWithinRoots, assertUrlAllowed, isBlockedIp, ToolSecurityError } from './security.ts';
