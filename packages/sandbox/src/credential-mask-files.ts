// Credential FILE masking — the on-disk half of credential-sentinel injection (see
// credential-sentinel.ts for the env half). A masked file's real content is read on the host,
// registered in the shared SentinelRegistry, and a FAKE file (content with real→sentinel) is
// written to a manager-owned temp dir. A launcher that can redirect a read (Linux + bwrap
// `--ro-bind`) binds the fake over the real path, so the confined child reads the sentinel; the
// TLS-terminating egress proxy swaps the sentinel back to the real value on the outbound leg, and
// ONLY for that credential's injectHosts. A tool doing `cat <maskedFile>` therefore sees a fake,
// but a request to an injectHost reaches upstream with the real bytes — no proxy changes needed
// (the proxy already scans every outbound header for any registered sentinel).
//
// Real file contents live ONLY in the in-memory SentinelRegistry. The fake file on disk contains
// ONLY sentinels; the real value is never written to disk and never logged.
//
// Without `extract`, masking is WHOLE-FILE: one sentinel replaces the entire content. With
// `extract` (a regex whose capture group 1 is the credential value), masking is STRUCTURED: only
// the matched span(s) are replaced, so a tool that parses the file (JSON/YAML/.netrc) still sees
// valid syntax.

import type { SentinelRegistry } from './credential-sentinel.ts';

import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { logger } from '@monad/logger';

import { type CredentialTransform, MAX_CREDENTIAL_BYTES, materializeCredential } from './credential-materializer.ts';

export const MASKED_FILE_STORE_PREFIX = 'monad-credmask-';

/** One masked file's declared source. `extract` (optional) is a regex whose capture group 1 is the
 *  credential value; without it the whole file is masked. */
export interface MaskedFileSpec {
  /** Sentinel-registry key stem — kept disjoint from env-var names via a `file:` prefix. */
  name: string;
  /** Host path of the real credential file (tilde-expanded and realpath'd internally). */
  realPath: string;
  /** Hosts the sentinel may be swapped back to the real value for (exact or subdomain). */
  injectHosts: string[];
  transform?: CredentialTransform;
  extract?: string;
}

/** A masked file's bind mapping consumed by a launcher's `policy.maskedFiles`. */
export interface MaskedFileBind {
  real: string;
  fake: string;
}

const FILE_KEY_PREFIX = 'file:';

/** Expand a leading `~`, resolve to absolute, then realpath (follows symlinks to the true target so
 *  the launcher binds/denies the same path the child's read resolves to). Falls back to the
 *  lexically-resolved path when the file does not exist yet. */
function resolveHostPath(p: string): string {
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Substitute credential span(s) in `content` per `pattern`, replacing each capture-group-1 span
 * with a sentinel minted for the captured value. Uses the `d` flag to get capture offsets, so the
 * output is built by slicing the ORIGINAL content between spans — an inserted sentinel is never
 * re-matched. Distinct captured values get distinct sentinels (keyed by index). Returns `null` when
 * the pattern matches nothing (caller decides how to degrade).
 */
export function extractAndSubstitute(
  content: string,
  pattern: string,
  sentinelFor: (capture: string, index: number) => string
): string | null {
  const re = new RegExp(pattern, 'gd');
  const indexByCapture = new Map<string, number>();
  const spans: { start: number; end: number; sentinel: string }[] = [];
  for (const m of content.matchAll(re)) {
    const cap = m[1];
    if (cap === undefined) {
      throw new Error(
        `extract pattern /${pattern}/ matched at offset ${m.index} but capture group 1 is ` +
          'undefined — group 1 must capture the credential value on every match.'
      );
    }
    if (cap.length === 0) continue;
    let i = indexByCapture.get(cap);
    if (i === undefined) {
      i = indexByCapture.size;
      indexByCapture.set(cap, i);
    }
    const indices = (m as RegExpMatchArray & { indices: Array<[number, number] | undefined> }).indices;
    const span = indices[1];
    if (!span) continue;
    spans.push({ start: span[0], end: span[1], sentinel: sentinelFor(cap, i) });
  }
  if (spans.length === 0) return null;
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += content.slice(pos, s.start) + s.sentinel;
    pos = s.end;
  }
  return out + content.slice(pos);
}

/**
 * Manager-owned temp dir (0o700) holding the fake files (0o600). Real file contents are read on
 * `add`, registered in the SentinelRegistry, and only the fake (sentinel) content touches disk.
 * `dispose()` removes the dir. Never logs real content.
 */
export class MaskedFileStore {
  private dir: string | undefined;
  private readonly binds: MaskedFileBind[] = [];
  private readonly denied: string[] = [];
  private seq = 0;

  /**
   * Read `spec.realPath`, register its credential value(s) in `registry` (minting sentinel(s)),
   * write the fake (sentinel-substituted) content to the temp dir, and record the bind. Returns the
   * bind, or `undefined` when the file cannot be masked (missing / unreadable / directory / binary, or
   * an `extract` regex that matched nothing). **Fail-closed:** a file that can't be masked has its
   * resolved real path added to `denyPaths` so the caller denies the child's read of it — a declared
   * credential file is NEVER left readable in cleartext just because masking failed.
   */
  add(registry: SentinelRegistry, spec: MaskedFileSpec): MaskedFileBind | undefined {
    const real = resolveHostPath(spec.realPath);

    let content: string;
    try {
      const stat = statSync(real);
      if (stat.isDirectory()) {
        logger.warn(`monad: masked credential file "${spec.realPath}" resolves to a directory — denying read.`);
        this.denied.push(real);
        return undefined;
      }
      if (stat.size > MAX_CREDENTIAL_BYTES) {
        logger.warn(`monad: masked credential file "${spec.realPath}" failed: INPUT_TOO_LARGE — denying read.`);
        this.denied.push(real);
        return undefined;
      }
      const raw = readFileSync(real);
      content = raw.toString('utf8');
      // A utf8 read maps invalid bytes to U+FFFD; the sentinel would then round-trip to corrupted
      // bytes at the proxy. Masking is for text credential files — reject binary (deny, not skip).
      if (Buffer.byteLength(content, 'utf8') !== raw.length) {
        logger.warn(
          `monad: masked credential file "${spec.realPath}" is not UTF-8 (binary files are not ` +
            'supported in mask mode) — denying read.'
        );
        this.denied.push(real);
        return undefined;
      }
    } catch (err) {
      // Unreadable/missing: deny the path anyway (fail-closed — if it appears later, the child still
      // can't read it in cleartext).
      logger.warn(
        `monad: masked credential file "${spec.realPath}" is unreadable on the host (${(err as Error).message}) — denying read.`
      );
      this.denied.push(real);
      return undefined;
    }

    const transform =
      spec.extract === undefined
        ? spec.transform
        : { ...spec.transform, extract: spec.transform?.extract ?? spec.extract };
    const materialized = materializeCredential(content, spec.injectHosts, transform);
    if (!materialized.ok) {
      logger.warn(`monad: masked credential file "${spec.realPath}" failed: ${materialized.error} — denying read.`);
      this.denied.push(real);
      return undefined;
    }
    const key = FILE_KEY_PREFIX + spec.name;
    registry.registerSubstitutions(key, materialized.value.substitutions);
    const fakeContent = materialized.value.childValue;

    if (this.dir === undefined) this.dir = mkdtempSync(join(tmpdir(), MASKED_FILE_STORE_PREFIX));
    const fake = join(this.dir, `${this.seq++}.fake`);
    // Unlink any stale entry first (defence in depth — a prior run could have planted a symlink)
    // so writeFileSync creates a fresh regular file. 0o600: owner-only; the child sees it read-only
    // via the launcher's --ro-bind regardless of host mode.
    rmSync(fake, { force: true });
    writeFileSync(fake, fakeContent, { mode: 0o600 });
    const bind: MaskedFileBind = { real, fake };
    this.binds.push(bind);
    return bind;
  }

  /** All bind mappings accumulated so far — feed to `configureSandboxMaskedFiles`. */
  get list(): readonly MaskedFileBind[] {
    return this.binds;
  }

  /** Real paths of declared credential files that could NOT be masked — feed to the read-deny set so
   *  they are never readable in cleartext (fail-closed). */
  get denyPaths(): readonly string[] {
    return this.denied;
  }

  /** Remove the temp dir and every fake file in it. Idempotent. */
  dispose(): void {
    if (this.dir !== undefined) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`monad: masked-file store cleanup failed: ${(err as Error).message}`);
      }
    }
    this.dir = undefined;
    this.binds.length = 0;
    this.denied.length = 0;
    this.seq = 0;
  }

  /** Temp dir path, or undefined before the first fake is written. */
  get dirPath(): string | undefined {
    return this.dir;
  }
}
