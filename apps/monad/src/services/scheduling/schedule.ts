// ScheduleService — the daemon backend for the schedule.* tools. It owns timing (one-shot
// and cron, via cron.ts), durable persistence (a JSON file under ~/.monad/run, atomically
// written so a crash mid-write can't corrupt it), and firing — delegating the actual agent
// run to an injected `fire` callback so this stays decoupled from agent/session internals.
//
// Cron semantics on restart: missed runs are NOT backfilled (next fire is recomputed from
// now). A missed one-shot IS run once on load (catch-up), then dropped.

import type { ScheduleCreateInput, ScheduleInfo, Scheduler } from '#/capabilities/tools/registry/schedule.ts';

import { renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { newId } from '@monad/protocol';

import { scheduleInfoSchema } from '#/capabilities/tools/registry/schedule.ts';
import { CronError, type CronFields, nextCronTime, parseCron } from '#/services/scheduling/cron.ts';

// setTimeout overflows past this (~24.8 days) and would fire immediately; longer waits re-arm
// in chunks until the real fire time arrives.
const MAX_TIMER_MS = 2_147_483_647;

interface Entry extends ScheduleInfo {
  cronFields?: CronFields;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ScheduleOptions {
  /** Where to persist the schedule set. */
  storePath: string;
  /** Run a scheduled prompt — start a fresh session when sessionId is undefined. */
  fire: (prompt: string, sessionId: string | undefined) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  log?: (msg: string) => void;
  /** Cap on concurrent schedules. Default 100. */
  maxSchedules?: number;
}

export class ScheduleService implements Scheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly storePath: string;
  private readonly fire: ScheduleOptions['fire'];
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly maxSchedules: number;

  constructor(opts: ScheduleOptions) {
    this.storePath = opts.storePath;
    this.fire = opts.fire;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
    this.maxSchedules = opts.maxSchedules ?? 100;
  }

  create(input: ScheduleCreateInput): ScheduleInfo {
    if (this.entries.size >= this.maxSchedules) {
      throw new Error(`too many schedules (max ${this.maxSchedules})`);
    }
    const now = this.now();
    const id = newId('sched');
    let entry: Entry;

    if (input.cron !== undefined) {
      const cronFields = parseCron(input.cron); // throws CronError on bad expression
      const next = nextCronTime(cronFields, now);
      if (!next) throw new CronError(`cron expression "${input.cron}" never matches`);
      entry = {
        id,
        prompt: input.prompt,
        kind: 'cron',
        spec: input.cron,
        sessionId: input.sessionId,
        nextFireAt: next.toISOString(),
        createdAt: now.toISOString(),
        cronFields
      };
    } else {
      const at = input.at !== undefined ? new Date(input.at) : new Date(now.getTime() + (input.delayMs ?? 0));
      if (Number.isNaN(at.getTime())) throw new Error(`invalid "at" timestamp: ${input.at}`);
      entry = {
        id,
        prompt: input.prompt,
        kind: 'once',
        spec: at.toISOString(),
        sessionId: input.sessionId,
        nextFireAt: at.toISOString(),
        createdAt: now.toISOString()
      };
    }

    this.entries.set(id, entry);
    this.arm(entry);
    this.persist();
    return this.toInfo(entry);
  }

  list(): ScheduleInfo[] {
    return [...this.entries.values()].map((e) => this.toInfo(e));
  }

  cancel(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.timer) clearTimeout(e.timer);
    this.entries.delete(id);
    this.persist();
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Load persisted schedules and arm them. Recomputes cron next-times; runs due one-shots. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return; // nothing persisted yet
      throw err;
    }
    let parsed: ScheduleInfo[];
    try {
      const result = scheduleInfoSchema.array().safeParse(JSON.parse(raw));
      if (!result.success) {
        this.log('schedule: store file does not match schema — ignoring');
        return;
      }
      parsed = result.data;
    } catch {
      this.log('schedule: store file is not valid JSON — ignoring');
      return;
    }

    const now = this.now();
    for (const info of parsed) {
      if (info.kind === 'cron') {
        let cronFields: CronFields;
        try {
          cronFields = parseCron(info.spec);
        } catch {
          continue; // drop a schedule whose cron no longer parses
        }
        const next = nextCronTime(cronFields, now);
        if (!next) continue;
        const entry: Entry = { ...info, nextFireAt: next.toISOString(), cronFields };
        this.entries.set(entry.id, entry);
        this.arm(entry);
      } else {
        const entry: Entry = { ...info };
        this.entries.set(entry.id, entry);
        this.arm(entry); // arm() fires immediately if the time is already past
      }
    }
    this.persist();
  }

  dispose(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
  }

  private arm(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.nextFireAt) return;
    const delay = new Date(entry.nextFireAt).getTime() - this.now().getTime();
    if (delay > MAX_TIMER_MS) {
      // Too far out for one timer — wake up later and re-arm.
      entry.timer = setTimeout(() => this.arm(entry), MAX_TIMER_MS);
      return;
    }
    entry.timer = setTimeout(() => void this.onFire(entry.id), Math.max(0, delay));
  }

  private async onFire(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      await this.fire(entry.prompt, entry.sessionId);
    } catch (err) {
      this.log(`schedule ${id} fire failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (entry.kind === 'cron' && entry.cronFields) {
      const next = nextCronTime(entry.cronFields, this.now());
      if (next) {
        entry.nextFireAt = next.toISOString();
        this.arm(entry);
        this.persist();
        return;
      }
    }
    // One-shot, or a cron with no further matches — retire it.
    this.entries.delete(id);
    this.persist();
  }

  private toInfo(e: Entry): ScheduleInfo {
    return {
      id: e.id,
      prompt: e.prompt,
      kind: e.kind,
      spec: e.spec,
      sessionId: e.sessionId,
      nextFireAt: e.nextFireAt,
      createdAt: e.createdAt
    };
  }

  // Synchronous + atomic (tmp + rename): schedule mutations are rare, and a sync write keeps
  // create/cancel side-effect-free of unawaited promises and free of read-after-write races.
  private persist(): void {
    const data = JSON.stringify(this.list(), null, 2);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, data, 'utf-8');
      renameSync(tmp, this.storePath);
    } catch (err) {
      this.log(`schedule: failed to persist: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
