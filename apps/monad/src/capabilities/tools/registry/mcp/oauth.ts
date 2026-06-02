// OAuth primitives for MCP HTTP servers (MCP authorization spec, 2025-06-18).
//
// The interactive authorization-code + PKCE flow runs on the official MCP SDK's `auth()`
// orchestrator (see apps/monad/src/services/mcp-oauth.ts). What remains here is the device flow
// (RFC 8628), which the SDK does not implement, plus the discovery + canonicalization helpers it
// needs. Fetch-injectable so the device flow is unit-testable without a live authorization server.
// The protocol is split by concern under ./mcp-oauth/ — this file is the public barrel:
//   • discovery  — Protected Resource (RFC 9728) + Auth Server (RFC 8414) metadata, Resource
//                  Indicators (RFC 8707) canonicalization.
//   • tokens     — token-response parsing (shared with the device poller).
//   • device     — Device Authorization Grant (RFC 8628) for headless/remote daemons.
//   • shared     — injectable fetch type, error class, and the persisted-token shape.

export { pollDeviceToken, startDeviceAuthorization } from './oauth/device.ts';
export {
  canonicalResourceUri,
  defaultResourceMetadataUrl,
  discoverAuthServer,
  discoverProtectedResource
} from './oauth/discovery.ts';
export { McpOAuthError, type StoredOAuth } from './oauth/shared.ts';
