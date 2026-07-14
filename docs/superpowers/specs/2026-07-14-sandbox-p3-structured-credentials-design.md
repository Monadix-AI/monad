# Sandbox P3 Structured Credentials Design

## Goal

Extend Monad's existing credential sentinel and TLS-terminating egress pipeline so structured environment values and files remain usable inside a sandbox without exposing real credentials. Add bounded extraction, duplicate masking, JWT-shaped fakes, and claim masking while preserving host-gated restoration for explicitly configured destination domains.

This is a shared `@monad/sandbox` capability. `@monad/sandbox-vm` consumes the resulting child environment, fake-file mount mappings, and proxy port through the existing launcher contract rather than implementing a VM-specific credential system.

## Existing Foundation

Monad already provides:

- whole-value environment sentinels;
- whole-file and capture-group file masking;
- read-only fake-file overlays with fail-closed read denial;
- HTTP and SOCKS multiplexing;
- TLS termination with bounded header and body rewriting;
- per-credential `injectHosts` matching.

P3 generalizes materialization and registry mappings. It does not replace the proxy or move real secrets into the guest.

## Configuration Contract

The canonical credential shape becomes:

```ts
interface SandboxCredentialTransform {
  extract?: string;
  maskDuplicates?: boolean;
  decode?: 'jwt';
  maskClaims?: string[];
}

interface SandboxCredential {
  name: string;
  injectHosts: string[];
  value?: string;
  file?: string;
  transform?: SandboxCredentialTransform;
}
```

Exactly one of `value` or `file` remains required. Compatibility parsing accepts the current top-level `extract` field and normalizes it to `transform.extract`; writers emit only the canonical nested form.

Validation rules:

- `maskDuplicates` requires `extract`;
- `maskClaims` requires `decode: 'jwt'` and contains unique, non-empty top-level claim names;
- `extract` and `decode: 'jwt'` may be combined: extraction locates token candidates, then JWT decoding validates each candidate;
- transform strings, claim counts, credential counts, input bytes, and generated output bytes are bounded;
- `injectHosts` uses the existing normalized exact-or-subdomain matching contract.

No new environment-variable feature switch is introduced.

## Materialization Pipeline

Every credential passes through one host-only materializer and produces:

```ts
interface MaterializedCredential {
  childValue: string;
  substitutions: Array<{
    fake: string;
    real: string;
    injectHosts: string[];
  }>;
}
```

The caller places `childValue` in the child environment or a manager-owned fake file. Only `substitutions` enters the in-memory registry. Real values never enter `SandboxPolicy`, VM identity, fake files, errors, or logs.

### Regex extraction

Capture group 1 identifies each credential span. The materializer builds output from original offsets so inserted sentinels cannot be re-matched. Repeated identical captures reuse one mapping. With `maskDuplicates`, every verbatim occurrence of a successfully captured value is replaced after all extraction spans are known.

Extraction runs in a bounded worker over at most 1 MiB of UTF-8 input with a fixed deadline. Timeout, invalid regex, missing capture group, empty capture, overlapping spans, or no matches is a materialization failure.

### JWT decoding

JWT handling accepts exactly three base64url segments. The decoded payload must be a JSON object and remain below configured byte and nesting limits. Monad does not verify the original signature because it may not own the verification key; it only verifies structural decoding before masking.

Without `maskClaims`, the child receives a JWT-shaped fake with non-secret randomized payload and signature segments. With `maskClaims`, only named top-level string claims are replaced by sentinels; unrelated claims retain their original JSON types and values. The fake token is registered as a whole-token mapping back to the original token so the upstream receives the byte-identical credential.

The generated signature segment is random filler and must not be a usable signature. Missing or non-string requested claims are reported as bounded configuration diagnostics and cannot silently expose the original claim.

## Fail-Closed Semantics

For a file credential, any materialization failure adds the canonical real path to `readDenyRoots`; the child cannot read the cleartext file. For an environment credential, failure omits the variable from the child environment. Neither path falls back to the real value.

Binary files, oversized files, unreadable paths, directories, symlink ambiguity, extraction timeout, and invalid JWTs follow the same rule. Diagnostic text names the credential and failure enum but never includes secret bytes, regex captures, tokens, or file contents.

## Destination-Gated Restoration

The TLS-terminating proxy is the only restoration point. It substitutes a fake value only when:

1. the request passed the domain allow/deny policy;
2. TLS termination successfully authenticated the upstream target;
3. the normalized target matches that mapping's `injectHosts`;
4. the sentinel occurs in a bounded HTTP/1.1 header block or bounded, non-chunked UTF-8 body.

Opaque CONNECT tunnels, SOCKS payloads, WebSocket upgrades, excluded TLS domains, plaintext destinations, oversized bodies, chunked bodies, and binary bodies never receive real credentials. They carry the fake or fail authentication.

Mappings remain per credential. A sentinel minted for credential A cannot be restored merely because credential B allows the destination. Denied domains take precedence over `injectHosts`.

## Lifecycle and Identity

One registry and fake-file store belong to one sandbox manager/session lifecycle. Rotation rebuilds materialized values, increments a non-secret credential generation identifier, disposes affected VM/launcher state, and deletes old fake files. The generation identifier participates in reuse invalidation; secret values and secret hashes do not.

The manager uses transactional replacement: resolve and materialize every credential first, publish the new registry and fake store only after success, then dispose the old generation. Partial rotation cannot mix old fakes with new real mappings.

## Testing

Tests cover:

- legacy `extract` normalization and canonical serialization;
- structured env and file values with multiple captures;
- duplicate masking on and off;
- invalid, timed-out, no-match, empty, and overlapping extraction;
- JWT shape, malformed base64url, invalid JSON, scalar payloads, missing claims, non-string claims, and bounded nesting;
- whole-token restoration for a fake JWT;
- exact host, subdomain, sibling-domain, denied-domain, Unicode/punycode, IP literal, and trailing-dot cases;
- header and body restoration plus opaque and oversized paths that retain fakes;
- cross-credential laundering attempts;
- rotation and cleanup without secret-bearing diagnostics;
- real-VM file masking on vfkit, KVM, and Hyper-V with a host TLS oracle.

## Success Criteria

- tools can parse supported structured fakes without seeing the real credential;
- only an authenticated matching destination receives the original bytes;
- transform failure is deny or omit, never cleartext fallback;
- existing untransformed credential configurations retain their behavior;
- no secret-derived material enters VM identity, logs, violations, or persistent config output.
