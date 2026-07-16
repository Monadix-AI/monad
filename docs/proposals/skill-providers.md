# Proposal: pluggable skill sources

Status: **implemented** — shipped in `apps/monad/src/capabilities/skills/` (`install/{git,tarball,clawhub}.ts` + `sources/{clawhub,marketplaces}.ts`, ref parsing, consent + `.install.json` lock). Body kept as the historical design record.

## Problem

Monad can only install a skill from a **local directory** (`installSkillFromDir`). The broader
agent ecosystem has supply chains with publish, version, and search workflows, and community
skills are commonly distributed as **git repos** or **tarballs**. Monad has no way
to pull a skill from any of these, no versioning, and no integrity/provenance story for remote
skills.

Goal: a thin **provider abstraction** so `monad skills install <ref>` can resolve a skill from
any source — local dir, git, HTTP tarball, ClawHub, or a future custom registry — behind one
uniform interface, while keeping the security posture Monad already applies to provider atoms
and MCP servers.

## Current state

- `installSkillFromDir(srcDir, destSkillsDir)` — copies a validated skill dir into `~/.monad/skills`.
- `SkillRegistry.discoverMany([...])` — discovers from home + workspace scopes.
- Trust boundary already documented for skills (executable instruction text from disk) in
  `docs/engineering/security-guidelines.md`; MCP servers already model remote-trust with `trust.pinnedToolHash`
  + `autoApproveTools` — **reuse that mental model.**

## Design

### 1. `SkillSource` interface

Mirror the `ModelProviderRegistry` discover-from-source pattern. A source resolves a **reference**
into a **staged local package**; the existing validate + `installSkillFromDir` path takes it from
there. Sources never execute skill code.

```ts
interface SkillRef {
  raw: string;            // what the user typed
  scheme: 'name' | 'clawhub' | 'git' | 'http' | 'file';
  name?: string;          // skill name (when known pre-resolve)
  version?: string;       // semver or tag, optional
  location?: string;      // url / path
}

interface ResolvedSkillPackage {
  stagedDir: string;      // a temp dir containing the skill (SKILL.md + resources)
  name: string;
  version?: string;
  source: { id: string; ref: string };  // provenance, recorded in the lockfile
  integrity: string;      // sha256 of the canonicalised package
}

interface SkillSource {
  id: string;                                   // 'clawhub' | 'git' | 'http' | 'file'
  match(ref: SkillRef): boolean;                // does this source handle the ref?
  resolve(ref: SkillRef): Promise<ResolvedSkillPackage>;  // fetch + stage (no execution)
  search?(query: string): Promise<SkillSearchResult[]>;   // optional (ClawHub)
}
```

### 2. Reference grammar

```
research                       → default registry (ClawHub), latest
clawhub:research@1.2.0         → ClawHub, pinned version
git+https://github.com/u/r     → git repo (whole repo = one skill, or /subdir)
https://x.com/research.tar.gz  → HTTP tarball
file:./skills/research         → local dir (today's behaviour)
```

### 3. Install flow

```
parseRef → source.match → source.resolve (fetch to temp, verify size/paths)
  → parseSkillMd + schema validate + name==dir + requires/compatibility gates
  → integrity hash → installSkillFromDir(stagedDir, ~/.monad/skills)
  → record in skills.lock → ReloadService picks it up live
```

A failed/refused resolve never mutates `~/.monad/skills`. Staging happens in a temp dir that is
removed on failure.

### 4. Lockfile — `~/.monad/skills.lock`

Reproducible installs + rug-pull detection (the MCP `pinnedToolHash` idea applied to skills):

```jsonc
{ "research": { "source": "clawhub", "ref": "clawhub:research@1.2.0",
                "version": "1.2.0", "integrity": "sha256-…" } }
```

`monad skills update` re-resolves; a changed integrity hash for the same version is surfaced as a
warning, not silently applied.

### 5. ClawHub adapter

A `SkillSource` over ClawHub's REST API:
- `search(query)` → `GET /skills?q=…` (vector search) → name/desc/version/score.
- `resolve(name, version)` → `GET /skills/{name}/{version}` → tarball URL + published hash;
  download, verify hash matches, stage.
- Auth optional (public read); publish is out of scope for the client.

Config (mirrors `mcpServers` trust shape):

```jsonc
"skills": {
  "sources": [
    { "id": "clawhub", "type": "clawhub", "endpoint": "https://clawhub.dev/api",
      "trust": { "requireIntegrity": true } }
  ]
}
```

### 6. Versioning

- SKILL.md gains optional `version` (semver). Surfaced in `skills.list` + CLI.
- `compatibility` becomes **enforced** at install (see proposal-adjacent item #8): a skill
  declaring an incompatible Monad version is refused.

## Security

Remote skills are the highest-risk supply-chain surface — treat the source as hostile:
- **Explicit install only** — never auto-fetch from a description or model request.
- **Integrity-pin** every remote package; verify before install; lockfile detects drift.
- **Never execute on install** — L3 scripts run only later, through the gate/sandbox, like any tool.
- **Tarball hardening** — reject `..`/absolute paths, symlink escapes, oversized members, zip-bombs.
- **Gates still apply** — `requires`/`compatibility` filter at load; `allowed-tools` from a remote
  skill is still a gate-bypass grant, so provenance (which source, pinned hash) is what the operator
  vets. Surface source + integrity in `monad skills`.

## Phasing

1. **Abstraction + git/http/file sources** — the interface, ref parser, staging, lockfile, tarball
   hardening. No registry yet. Unlocks `install <git-url|tarball>`.
2. **ClawHub adapter** — search + resolve + verify against the registry.
3. **Versioning + `update` + compatibility enforcement** — semver, drift detection.
4. **Custom registries** — same `SkillSource` contract, operator-configured endpoints.

## Open questions

- One skill per git repo vs a repo of many (`/skills/*`)? Support both via an optional subpath.
- Do we want a `monad skills publish` client, or leave publishing to ClawHub's own tooling?
- Should workspace/project skills (proposal item #3) be installable into the repo scope, not just home?
