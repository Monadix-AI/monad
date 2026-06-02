---
title: "Operation Source"
description: "Every session records where it came from in an immutable origin value. The persisted field keeps its historical name, but its schema and type are."
---
Every session records where it came from in an immutable `origin` value. The persisted
field keeps its historical name, but its schema and type are `operationSourceSchema`
and `OperationSource` in
[`@monad/protocol`](https://github.com/Monadix-AI/monad/blob/main/packages/protocol/src/domain.ts).

`OperationSource` is provenance and routing context:

```ts
type OperationSource = {
  surface: 'editor' | 'web' | 'tui' | 'im' | 'api' | 'automation';
  client: string;
  clientVersion?: string;
  instanceId?: string;
  transport: 'http' | 'acp' | 'channel';
};
```

- `surface` is the coarse, closed product surface.
- `client` is the concrete open identifier, such as `monad-web`, `monad-cli`,
  `telegram`, `zed`, or `vscode`.
- `clientVersion` identifies the client build when known.
- `instanceId` distinguishes configured instances of one client, such as a channel
  configuration ID.
- `transport` is the server-stamped semantic ingress class. It is not the physical
  TCP-versus-Unix-socket choice.

The previous `SessionOrigin` access arrays, environment snapshot, and open extension
bag were removed. Do not add `writableBy`, `branchableBy`, `env`, or `ext` back to this
contract. Environment data included unnecessary PII; open extension data had no stable
domain meaning; per-session transport arrays incorrectly made provenance look like an
authorization identity.

## Stamping boundary

Clients may suggest only bounded identity fields accepted by
`createOperationSourceHintSchema`. The transport controller constructs the complete
value with `buildOperationSource`; callers never choose their own `transport`.

| Ingress | Default surface | Default client | Server transport |
|---|---|---|---|
| HTTP / web | `web` | `monad-web` | `http` |
| Native JSON-RPC / CLI / TUI | `tui` | `monad-cli` | `http` |
| ACP editor | `editor` | editor `clientInfo.name` | `acp` |
| IM channel | `im` | adapter type | `channel` |

A branch is stamped from the ingress that creates the branch, rather than copying the
parent's source. Channel operator guidance is built as turn-local `ambientContext`; it
is not persisted in `origin`.

## Authority boundary

The durable contract remains provenance-only. Connection admission, tool approval, and scoped
runtime capabilities own authorization.

There is currently one explicit containment exception:
[`assertTransportAuthority`](https://github.com/Monadix-AI/monad/blob/main/apps/monad/src/handlers/session/transport-authority.ts)
uses the server-stamped `origin.transport` on five session write/branch entry points.
It prevents one semantic transport from mutating another transport's session until the
trusted-native versus model-child capability boundary is complete. It is intentionally
stricter than the removed arrays, has no client override, and must not grow into a
general identity or RBAC system. Sessions without an origin retain legacy behavior;
automation-origin sessions reject transport writes.

Tests:
[session-write-policy.test.ts](https://github.com/Monadix-AI/monad/blob/main/apps/monad/test/unit/sessions/session-write-policy.test.ts)
and
[session-transport-authority.test.ts](https://github.com/Monadix-AI/monad/blob/main/apps/monad/test/e2e/session-transport-authority.test.ts).
