// The unified slash-command registry. First-party built-ins and third-party atom commands both
// land here via the SAME defineCommand mechanism; built-ins win on name conflicts and CANNOT be
// shadowed by an atom (the opposite of channel/registry.ts's last-write-wins merge — that is
// deliberate). Skills are not stored here; they are merged in at list() time as kind:'prompt'.

import type { Translate } from '@monad/i18n';
import type { CommandSpec } from '@monad/protocol';
import type { CommandDefinition } from '@monad/sdk-atom';

export interface RegistryEntry {
  def: CommandDefinition;
  source: 'builtin' | 'atom';
  atomName?: string;
}

/** Minimal skill view needed to surface skills as kind:'prompt' commands in discovery. */
export interface SkillCommandView {
  name: string;
  description: string;
  version?: string;
  icon?: string;
  userInvocable: boolean;
  available: boolean;
}

export type RegistryLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** Command names/aliases must match the parser (lowercase-with-hyphens) or they'd register but never
 *  be reachable via parseSlashCommand. Same shape as a skill name. */
const COMMAND_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Runtime guard: an atom command crosses the trust boundary as `unknown`, so validate its shape
 *  (name/description strings + a run function) before it enters the registry. */
function isCommandDefinition(value: unknown): value is CommandDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.name !== 'string' || typeof d.description !== 'string' || typeof d.run !== 'function') return false;
  if (d.aliases !== undefined && (!Array.isArray(d.aliases) || d.aliases.some((a) => typeof a !== 'string')))
    return false;
  return true;
}

export class CommandRegistry {
  private readonly entries = new Map<string, RegistryEntry>(); // canonical name → entry
  private readonly keys = new Map<string, string>(); // name|alias|qualified → canonical name
  private readonly reserved = new Set<string>(); // every built-in name + alias
  // Atom commands namespace-coexist: each is canonical under `<atomName>.<name>` and always reachable
  // as `/<atomName>.<name>`; the BARE name resolves to one winner (pin ?? first-wins) in resolvePins,
  // unless a built-in reserves it. bare key → candidates in registration order.
  private readonly bareCandidates = new Map<string, { canonical: string; atomName: string }[]>();

  constructor(private readonly log: RegistryLog = () => {}) {}

  registerBuiltin(def: CommandDefinition): void {
    for (const key of this.allKeys(def)) {
      if (this.reserved.has(key)) {
        this.log('warn', `command "${key}" already reserved by a built-in; skipping duplicate built-in "${def.name}"`);
        return;
      }
    }
    this.entries.set(def.name, { def, source: 'builtin' });
    for (const key of this.allKeys(def)) {
      this.keys.set(key, def.name);
      this.reserved.add(key);
    }
  }

  /** Register an atom command (untrusted `unknown` until validated). Rejected — with a warning — when:
   *  the shape is invalid; a name/alias isn't a valid command token; a name/alias collides with a
   *  built-in (built-ins are not overridable) or with an already-registered command (first-wins). */
  registerAtom(atomName: string, raw: unknown): void {
    if (!isCommandDefinition(raw)) {
      this.log(
        'warn',
        `atom pack "${atomName}" registered a malformed command (needs name, description, run) — skipped`
      );
      return;
    }
    const def = raw;
    for (const key of this.allKeys(def)) {
      if (!COMMAND_NAME_RE.test(key)) {
        this.log('warn', `atom pack "${atomName}" command name "${key}" must be lowercase-with-hyphens — rejected`);
        return;
      }
    }
    // Canonical = the always-addressable qualified name; the bare name(s) are resolved in resolvePins.
    const canonical = `${atomName}.${def.name}`;
    if (this.entries.has(canonical)) {
      this.log('warn', `atom pack "${atomName}" registered a duplicate command "${def.name}" — skipped`);
      return;
    }
    this.entries.set(canonical, { def, source: 'atom', atomName });
    for (const key of this.allKeys(def)) {
      this.keys.set(`${atomName}.${key}`, canonical); // qualified, always reachable
      const list = this.bareCandidates.get(key);
      if (list) list.push({ canonical, atomName });
      else this.bareCandidates.set(key, [{ canonical, atomName }]);
      // Claim the bare name first-wins now so it resolves without an explicit resolvePins; a built-in
      // reserves it (cannot be overridden), and a later atom can't take an already-claimed bare name.
      if (this.reserved.has(key)) {
        this.log(
          'warn',
          `atom pack "${atomName}" command "${key}" collides with a built-in command and was rejected (built-ins cannot be overridden); use /${atomName}.${key}`
        );
      } else if (!this.keys.has(key)) {
        this.keys.set(key, canonical);
      }
    }
  }

  /** Resolve every bare atom-command name to one winner: the user pin (`atomPins.command`, bare →
   *  packId) when that pack provides it, else first-wins by registration order. A name reserved by a
   *  built-in is never taken (the qualified `<pack>.<name>` form still works). Call once after the
   *  atom-discovery sweep (and after clearAtoms on re-discovery). */
  resolvePins(
    pins: Readonly<Record<string, string>> = {},
    onConflict?: (c: { kind: 'command'; bareId: string; winner: string; shadowed: string[] }) => void
  ): void {
    for (const [bare, candidates] of this.bareCandidates) {
      if (this.reserved.has(bare)) continue; // built-in owns the bare name
      const pinned = pins[bare];
      const winner = candidates.find((c) => c.atomName === pinned) ?? candidates[0];
      if (winner) this.keys.set(bare, winner.canonical);
      if (candidates.length > 1 && winner) {
        onConflict?.({
          kind: 'command',
          bareId: bare,
          winner: winner.atomName,
          shadowed: candidates.filter((c) => c.atomName !== winner.atomName).map((c) => c.atomName)
        });
      }
    }
  }

  /** Remove all commands registered by the named atom. No-op if the atom has no entries.
   *  Call before re-running atom discovery so a removed atom's commands disappear. */
  deregisterAtom(atomName: string): void {
    for (const [canonical, entry] of this.entries) {
      if (entry.source === 'atom' && entry.atomName === atomName) this.entries.delete(canonical);
    }
    this.pruneOrphanKeys();
    for (const [bare, list] of this.bareCandidates) {
      const kept = list.filter((c) => c.atomName !== atomName);
      if (kept.length) this.bareCandidates.set(bare, kept);
      else this.bareCandidates.delete(bare);
    }
  }

  /** Remove ALL atom-registered commands (built-ins are preserved). Used before a full
   *  re-discovery so stale commands from removed atoms don't linger. */
  clearAtoms(): void {
    for (const [canonical, entry] of this.entries) {
      if (entry.source === 'atom') this.entries.delete(canonical);
    }
    this.pruneOrphanKeys();
    this.bareCandidates.clear();
  }

  /** Drop any key whose canonical target no longer has an entry (after atom removals). */
  private pruneOrphanKeys(): void {
    for (const [key, canonical] of this.keys) {
      if (!this.entries.has(canonical)) this.keys.delete(key);
    }
  }

  resolve(nameOrAlias: string): RegistryEntry | undefined {
    const canonical = this.keys.get(nameOrAlias);
    return canonical ? this.entries.get(canonical) : undefined;
  }

  /** The full advertised command set: built-ins + atom commands + user-invocable skills. When `t`
   *  is given, a command's `description` is resolved from its `descriptionKey` (the active locale);
   *  skills keep their own description (not in the i18n catalog). */
  list(skills: SkillCommandView[] = [], t?: Translate): CommandSpec[] {
    const cmds: CommandSpec[] = [];
    for (const e of this.entries.values()) {
      const description = t && e.def.descriptionKey ? t(e.def.descriptionKey) : e.def.description;
      cmds.push({
        name: e.def.name,
        aliases: e.def.aliases ?? [],
        description,
        descriptionKey: e.def.descriptionKey,
        argHint: e.def.argHint,
        kind: 'builtin',
        source: e.source,
        atomName: e.atomName,
        available: true
      });
    }
    for (const s of skills) {
      if (!s.userInvocable) continue;
      if (this.keys.has(s.name)) continue; // a real command shadows a same-named skill in listings
      cmds.push({
        name: s.name,
        aliases: [],
        description: s.description,
        version: s.version,
        icon: s.icon,
        kind: 'prompt',
        source: 'skill',
        available: s.available
      });
    }
    return cmds.sort((a, b) => a.name.localeCompare(b.name));
  }

  private allKeys(def: CommandDefinition): string[] {
    return [def.name, ...(def.aliases ?? [])];
  }
}
