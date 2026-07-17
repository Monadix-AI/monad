/**
 * A tail-bounded text buffer for a session's live output snapshot. The streaming hot path appends one
 * chunk per token, and reads (observe / snapshot flush) happen on a throttle — so appends must be
 * cheap and joins are amortized. A single growing string would re-copy the whole (up to 256 KB)
 * buffer on every append: O(n) per chunk, O(n²) over a response. This keeps chunks in a list, trims
 * the front to stay within `max`, and memoizes the joined snapshot (collapsing to one chunk on read),
 * making append O(chunk) amortized while `snapshot()` stays a bounded join.
 *
 * Bound and trim are by UTF-16 length (`String.length`), matching the previous `appendBounded`.
 */
export class BoundedOutputBuffer {
  private chunks: string[] = [];
  private len = 0;
  private joined: string | null = '';
  private framed = false;

  constructor(private readonly max: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.len += chunk.length;
    this.joined = null;
    while (this.len > this.max && this.chunks.length > 0) {
      const first = this.chunks[0] ?? '';
      const overflow = this.len - this.max;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.len -= first.length;
      } else {
        this.chunks[0] = first.slice(overflow);
        this.len -= overflow;
      }
    }
  }

  appendFrame(frame: string): void {
    if (!frame || frame.length > this.max) return;
    this.framed = true;
    this.chunks.push(frame);
    this.len += frame.length;
    this.joined = null;
    while (this.len > this.max && this.chunks.length > 0) {
      const first = this.chunks.shift() ?? '';
      this.len -= first.length;
    }
  }

  snapshot(): string {
    if (this.joined !== null) return this.joined;
    const s = this.chunks.length === 1 ? (this.chunks[0] ?? '') : this.chunks.join('');
    if (!this.framed) this.chunks = s ? [s] : [];
    this.len = s.length;
    this.joined = s;
    return s;
  }

  clear(): void {
    this.chunks = [];
    this.len = 0;
    this.joined = '';
    this.framed = false;
  }

  get length(): number {
    return this.len;
  }
}
