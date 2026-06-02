interface KvEntry {
  value: Buffer;
  exp: number | null; // unix ms; null = no expiry
}

export type SubCallback = (message: string) => void;

/** A single stream entry: an id plus a flat [field, value, field, value, …] list. */
export interface StreamEntry {
  id: string; // "<ms>-<seq>"
  fields: string[];
}

interface Stream {
  entries: StreamEntry[]; // ordered by id ascending (append-only, monotonic)
  lastMs: number;
  lastSeq: number;
}

/** Notified when an entry is appended to any of the streams it cares about. */
interface StreamWaiter {
  keys: ReadonlySet<string>;
  notify: () => void;
}

export class KvStore {
  private readonly data = new Map<string, KvEntry>();
  private readonly streams = new Map<string, Stream>();
  private readonly streamWaiters = new Set<StreamWaiter>();
  private readonly subs = new Map<string, Set<SubCallback>>();

  get(key: string): Buffer | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (this.#expired(entry)) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: Buffer, opts?: { px?: number; nx?: boolean; xx?: boolean }): boolean {
    const existing = this.data.get(key);
    if (opts?.nx && existing && !this.#expired(existing)) return false;
    if (opts?.xx && (!existing || this.#expired(existing))) return false;
    const exp = opts?.px != null ? Date.now() + opts.px : null;
    this.data.set(key, { value, exp });
    return true;
  }

  del(...keys: string[]): number {
    let count = 0;
    for (const k of keys) {
      if (this.data.delete(k)) count++;
      else if (this.streams.delete(k)) count++;
    }
    return count;
  }

  exists(...keys: string[]): number {
    let count = 0;
    for (const k of keys) {
      const entry = this.data.get(k);
      if (entry && !this.#expired(entry)) count++;
      else if (this.streams.has(k)) count++;
    }
    return count;
  }

  pexpire(key: string, ms: number): boolean {
    const entry = this.data.get(key);
    if (!entry || this.#expired(entry)) return false;
    entry.exp = Date.now() + ms;
    return true;
  }

  expire(key: string, seconds: number): boolean {
    return this.pexpire(key, seconds * 1000);
  }

  /** -2 = key does not exist, -1 = no expiry, ≥0 = remaining ms. */
  pttl(key: string): number {
    const entry = this.data.get(key);
    if (!entry || this.#expired(entry)) return -2;
    if (entry.exp === null) return -1;
    return Math.max(0, entry.exp - Date.now());
  }

  /** TTL in whole seconds (nearest second, Redis-compatible). */
  ttl(key: string): number {
    const p = this.pttl(key);
    return p < 0 ? p : Math.round(p / 1000);
  }

  persist(key: string): boolean {
    const entry = this.data.get(key);
    if (!entry || this.#expired(entry) || entry.exp === null) return false;
    entry.exp = null;
    return true;
  }

  keys(pattern: string): string[] {
    const re = globToRegex(pattern);
    const result: string[] = [];
    for (const [k, entry] of this.data) {
      if (!this.#expired(entry) && re.test(k)) result.push(k);
    }
    for (const k of this.streams.keys()) {
      if (re.test(k)) result.push(k);
    }
    return result;
  }

  type(key: string): 'string' | 'stream' | 'none' {
    const entry = this.data.get(key);
    if (entry && !this.#expired(entry)) return 'string';
    if (this.streams.has(key)) return 'stream';
    return 'none';
  }

  dbsize(): number {
    let count = this.streams.size;
    for (const [, entry] of this.data) {
      if (!this.#expired(entry)) count++;
    }
    return count;
  }

  flush(): void {
    this.data.clear();
    this.streams.clear();
  }

  sweep(): void {
    const now = Date.now();
    for (const [k, entry] of this.data) {
      if (entry.exp !== null && entry.exp <= now) this.data.delete(k);
    }
  }

  subscribe(channel: string, cb: SubCallback): () => void {
    let set = this.subs.get(channel);
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set?.size === 0) this.subs.delete(channel);
    };
  }

  publish(channel: string, message: string): number {
    const set = this.subs.get(channel);
    if (!set || set.size === 0) return 0;
    for (const cb of set) cb(message);
    return set.size;
  }

  subCount(channel: string): number {
    return this.subs.get(channel)?.size ?? 0;
  }

  /**
   * `rawId`: `*` (full auto), `<ms>-*` (auto seq), `<ms>-<seq>` (explicit), or bare `<ms>` (auto seq).
   * Returns null when `nomkstream` is set and the stream does not yet exist.
   * Throws `StreamError` for ids not strictly greater than the stream's top id.
   */
  xadd(key: string, rawId: string, fields: string[], opts?: { nomkstream?: boolean; maxlen?: number }): string | null {
    let stream = this.streams.get(key);
    if (!stream) {
      if (opts?.nomkstream) return null;
      stream = { entries: [], lastMs: 0, lastSeq: 0 };
      this.streams.set(key, stream);
    }

    const { ms, seq } = resolveAddId(rawId, stream);
    if (ms === 0 && seq === 0) {
      throw new StreamError('The ID specified in XADD must be greater than 0-0');
    }
    // Ids must strictly increase. An empty stream (lastMs/lastSeq = 0) accepts any id > 0-0.
    if (stream.entries.length > 0 && (ms < stream.lastMs || (ms === stream.lastMs && seq <= stream.lastSeq))) {
      throw new StreamError('The ID specified in XADD is equal or smaller than the target stream top item');
    }

    const id = idStr(ms, seq);
    stream.entries.push({ id, fields: [...fields] });
    stream.lastMs = ms;
    stream.lastSeq = seq;

    if (opts?.maxlen != null && stream.entries.length > opts.maxlen) {
      stream.entries.splice(0, stream.entries.length - opts.maxlen);
    }

    this.#wakeStreamWaiters(key);
    return id;
  }

  xlen(key: string): number {
    return this.streams.get(key)?.entries.length ?? 0;
  }

  xrange(key: string, start: string, end: string, count?: number): StreamEntry[] {
    const stream = this.streams.get(key);
    if (!stream) return [];
    const lo = parseRangeId(start, false);
    const hi = parseRangeId(end, true);
    const result: StreamEntry[] = [];
    for (const e of stream.entries) {
      const c = parseId(e.id);
      if (cmpId(c, lo) >= 0 && cmpId(c, hi) <= 0) {
        result.push(e);
        if (count != null && result.length >= count) break;
      }
    }
    return result;
  }

  xread(reqs: { key: string; afterId: string }[], count?: number): { key: string; entries: StreamEntry[] }[] {
    const out: { key: string; entries: StreamEntry[] }[] = [];
    for (const { key, afterId } of reqs) {
      const stream = this.streams.get(key);
      if (!stream) continue;
      const after = afterId === '$' ? { ms: stream.lastMs, seq: stream.lastSeq } : parseRangeId(afterId, false);
      const entries: StreamEntry[] = [];
      for (const e of stream.entries) {
        if (cmpId(parseId(e.id), after) > 0) {
          entries.push(e);
          if (count != null && entries.length >= count) break;
        }
      }
      if (entries.length > 0) out.push({ key, entries });
    }
    return out;
  }

  lastStreamId(key: string): string {
    const stream = this.streams.get(key);
    return stream ? idStr(stream.lastMs, stream.lastSeq) : '0-0';
  }

  xinfoStream(key: string): StreamInfo | null {
    const stream = this.streams.get(key);
    if (!stream) return null;
    return {
      length: stream.entries.length,
      lastGeneratedId: idStr(stream.lastMs, stream.lastSeq),
      firstEntry: stream.entries[0] ?? null,
      lastEntry: stream.entries[stream.entries.length - 1] ?? null
    };
  }

  addStreamWaiter(keys: string[], notify: () => void): () => void {
    const waiter: StreamWaiter = { keys: new Set(keys), notify };
    this.streamWaiters.add(waiter);
    return () => this.streamWaiters.delete(waiter);
  }

  #wakeStreamWaiters(key: string): void {
    if (this.streamWaiters.size === 0) return;
    // Snapshot first: a notified waiter typically unregisters itself mid-iteration.
    for (const waiter of [...this.streamWaiters]) {
      if (waiter.keys.has(key)) waiter.notify();
    }
  }

  channels(): { name: string; subscribers: number }[] {
    const out: { name: string; subscribers: number }[] = [];
    for (const [name, set] of this.subs) out.push({ name, subscribers: set.size });
    return out;
  }

  inspect(previewBytes = 200): StoreSnapshot {
    const strings: StoreSnapshot['strings'] = [];
    for (const [key, entry] of this.data) {
      if (this.#expired(entry)) continue;
      strings.push({
        key,
        ttlMs: this.pttl(key),
        size: entry.value.length,
        preview: entry.value.subarray(0, previewBytes).toString('utf8')
      });
    }

    const streams: StoreSnapshot['streams'] = [];
    for (const [key, stream] of this.streams) {
      streams.push({
        key,
        length: stream.entries.length,
        lastId: idStr(stream.lastMs, stream.lastSeq),
        entries: stream.entries
      });
    }

    return { strings, streams, channels: this.channels() };
  }

  #expired(entry: KvEntry): boolean {
    return entry.exp !== null && entry.exp <= Date.now();
  }
}

export interface StreamInfo {
  length: number;
  lastGeneratedId: string;
  firstEntry: StreamEntry | null;
  lastEntry: StreamEntry | null;
}

export interface StoreSnapshot {
  strings: { key: string; ttlMs: number; size: number; preview: string }[];
  streams: { key: string; length: number; lastId: string; entries: StreamEntry[] }[];
  channels: { name: string; subscribers: number }[];
}

/** Thrown for invalid stream ids; the command layer turns this into a RESP error. */
export class StreamError extends Error {}

interface StreamId {
  ms: number;
  seq: number;
}

function idStr(ms: number, seq: number): string {
  return `${ms}-${seq}`;
}

function parseId(id: string): StreamId {
  const dash = id.indexOf('-');
  const ms = Number(dash === -1 ? id : id.slice(0, dash));
  const seq = dash === -1 ? 0 : Number(id.slice(dash + 1));
  return { ms, seq };
}

function cmpId(a: StreamId, b: StreamId): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

function resolveAddId(rawId: string, stream: Stream): StreamId {
  if (rawId === '*') {
    const now = Date.now();
    if (now > stream.lastMs) return { ms: now, seq: 0 };
    return { ms: stream.lastMs, seq: stream.lastSeq + 1 };
  }

  const dash = rawId.indexOf('-');
  const msPart = dash === -1 ? rawId : rawId.slice(0, dash);
  const seqPart = dash === -1 ? '*' : rawId.slice(dash + 1);
  const ms = Number(msPart);
  if (!Number.isInteger(ms) || ms < 0) throw new StreamError('Invalid stream ID specified as stream command argument');

  if (seqPart === '*') {
    if (ms < stream.lastMs)
      throw new StreamError('The ID specified in XADD is equal or smaller than the target stream top item');
    const seq = ms === stream.lastMs ? stream.lastSeq + 1 : 0;
    return { ms, seq };
  }

  const seq = Number(seqPart);
  if (!Number.isInteger(seq) || seq < 0)
    throw new StreamError('Invalid stream ID specified as stream command argument');
  return { ms, seq };
}

/**
 * `-`/`+` are min/max sentinels; a bare `<ms>` gets seq=0 for a lower bound
 * (`isEnd=false`) or seq=MAX_SAFE_INTEGER for an upper bound (`isEnd=true`).
 */
function parseRangeId(raw: string, isEnd: boolean): StreamId {
  if (raw === '-') return { ms: 0, seq: 0 };
  if (raw === '+') return { ms: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER };
  const dash = raw.indexOf('-');
  if (dash === -1) {
    return { ms: Number(raw), seq: isEnd ? Number.MAX_SAFE_INTEGER : 0 };
  }
  return { ms: Number(raw.slice(0, dash)), seq: Number(raw.slice(dash + 1)) };
}

function globToRegex(pattern: string): RegExp {
  // Redis glob: * = any chars, ? = single char, [abc] = char class, \ = escape
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i++] ?? '';
    if (ch === '\\' && i < pattern.length) {
      re += escapeRegex(pattern[i++] ?? '');
    } else if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else if (ch === '[') {
      // Pass character classes through — they're valid regex syntax
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
      } else {
        re += `[${pattern.slice(i, end + 1)}`;
        i = end + 1;
      }
    } else {
      re += escapeRegex(ch);
    }
  }
  re += '$';
  return new RegExp(re);
}

function escapeRegex(ch: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal set of chars that need escaping
  return '.+^${}()|\\'.includes(ch) ? `\\${ch}` : ch;
}
