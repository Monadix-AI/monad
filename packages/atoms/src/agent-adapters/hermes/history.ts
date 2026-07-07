import type {
  ExternalAgentProviderHistoryPageContext,
  ExternalAgentProviderHistoryPageRequestContext
} from '@monad/sdk-atom';

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type SqliteScalar = string | number | bigint | boolean | null;
type JsonRecord = Record<string, unknown>;

const HISTORY_SOURCE = Symbol.for('monad.hermes.historySource');

function envValue(name: string): string | undefined {
  return Bun.env[name]?.trim() || undefined;
}

function hermesHome(): string {
  return envValue('HERMES_HOME') || join(homedir(), '.hermes');
}

function stateDbPath(): string {
  return join(hermesHome(), 'state.db');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function normalizeMessageRecord(record: JsonRecord): JsonRecord {
  return {
    ...record,
    content: parseJson(record.content),
    tool_calls: parseJson(record.tool_calls),
    session_id: stringValue(record.session_id),
    id: numberValue(record.id) ?? record.id
  };
}

function pageOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function sliceMessages(messages: JsonRecord[], args: { limit: number; offset: number; desc: boolean }) {
  const ordered = args.desc ? [...messages].reverse() : messages;
  const rows = ordered.slice(args.offset, args.offset + args.limit + 1);
  const hasMore = rows.length > args.limit;
  const pageRows = rows.slice(0, args.limit);
  return {
    items: args.desc ? pageRows.reverse() : pageRows,
    nextCursor: hasMore ? String(args.offset + args.limit) : undefined
  };
}

function apiBaseCandidates(): string[] {
  const explicit = [
    envValue('HERMES_API_BASE_URL'),
    envValue('HERMES_DASHBOARD_BASE_URL'),
    envValue('HERMES_BASE_URL')
  ].filter((value): value is string => !!value);
  if (explicit.length > 0) return explicit;
  return [...explicit, 'http://127.0.0.1:9119'];
}

function apiHeaders(): Record<string, string> | undefined {
  const token = envValue('HERMES_DASHBOARD_SESSION_TOKEN') ?? envValue('HERMES_API_TOKEN');
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

async function fetchJsonWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(url, { headers: apiHeaders(), signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function messagesViaApi(sessionRef: string): Promise<JsonRecord[] | undefined> {
  for (const base of apiBaseCandidates()) {
    const url = `${base.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(sessionRef)}/messages`;
    const payload = recordValue(await fetchJsonWithTimeout(url));
    const rawMessages = Array.isArray(payload?.messages)
      ? payload.messages
      : Array.isArray(payload?.data)
        ? payload.data
        : undefined;
    if (rawMessages) return rawMessages.map((item) => normalizeMessageRecord(recordValue(item) ?? {}));
  }
  return undefined;
}

async function runHermesExport(args: string[]): Promise<string | undefined> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: Timer | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      proc?.kill('SIGTERM');
      resolve(undefined);
    }, 5000);
  });
  try {
    proc = Bun.spawn(['hermes', 'sessions', 'export', '-', ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
      env: Bun.env
    });
    const output = await Promise.race([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), timeout]);
    const exit = await proc.exited;
    if (exit !== 0 || typeof output !== 'string') return undefined;
    return output;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseExportSessions(output: string): JsonRecord[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        const record = recordValue(parsed);
        return record ? [record] : [];
      } catch {
        return [];
      }
    });
}

function sessionMatchesRef(session: JsonRecord, sessionRef: string): boolean {
  const id = stringValue(session.id);
  const key = stringValue(session.session_key);
  return id === sessionRef || key === sessionRef || (id?.startsWith(sessionRef) ?? false);
}

function latestCompressionChild(sessions: JsonRecord[], sessionId: string): JsonRecord | undefined {
  const children = sessions
    .filter((session) => session.parent_session_id === sessionId)
    .filter((session) => stringValue(session.source) !== 'tool')
    .filter((session) => {
      const config = recordValue(parseJson(session.model_config)) ?? {};
      return config._branched_from === undefined && config._delegate_from === undefined;
    })
    .sort((a, b) => (numberValue(b.started_at) ?? 0) - (numberValue(a.started_at) ?? 0));
  return children[0];
}

function exportSessionWithResumeMessages(sessions: JsonRecord[], sessionRef: string): JsonRecord[] | undefined {
  const start = sessions
    .filter((session) => sessionMatchesRef(session, sessionRef))
    .sort((a, b) => (numberValue(b.started_at) ?? 0) - (numberValue(a.started_at) ?? 0))[0];
  if (!start) return undefined;

  let current = start;
  const seen = new Set<string>();
  let best = Array.isArray(current.messages) && current.messages.length > 0 ? current : undefined;
  for (let depth = 0; depth < 32; depth += 1) {
    const id = stringValue(current.id);
    if (!id || seen.has(id)) break;
    seen.add(id);
    const child = latestCompressionChild(sessions, id);
    if (!child || current.end_reason !== 'compression') break;
    current = child;
    if (Array.isArray(current.messages) && current.messages.length > 0) best = current;
  }

  const messages = Array.isArray(best?.messages) ? best.messages : [];
  return messages.map((item) => normalizeMessageRecord(recordValue(item) ?? {}));
}

async function messagesViaExport(sessionRef: string): Promise<JsonRecord[] | undefined> {
  const direct = await runHermesExport(['--session-id', sessionRef]);
  const directSessions = direct ? parseExportSessions(direct) : [];
  const directMessages = exportSessionWithResumeMessages(directSessions, sessionRef);
  if (directMessages && directMessages.length > 0) return directMessages;

  const all = await runHermesExport([]);
  const allSessions = all ? parseExportSessions(all) : [];
  return exportSessionWithResumeMessages(allSessions, sessionRef);
}

function queryOne(db: Database, sql: string, ...params: SqliteScalar[]): JsonRecord | undefined {
  return (db.query(sql).get(...params) as JsonRecord | null | undefined) ?? undefined;
}

function queryAll(db: Database, sql: string, ...params: SqliteScalar[]): JsonRecord[] {
  return db.query(sql).all(...params) as JsonRecord[];
}

function resolveHermesSessionId(db: Database, sessionRef: string): string | undefined {
  const exact = queryOne(db, 'SELECT id FROM sessions WHERE id = ? LIMIT 1', sessionRef);
  const exactId = stringValue(exact?.id);
  if (exactId) return exactId;

  const key = queryOne(
    db,
    'SELECT id FROM sessions WHERE session_key = ? ORDER BY started_at DESC, id DESC LIMIT 1',
    sessionRef
  );
  const keyId = stringValue(key?.id);
  if (keyId) return keyId;

  const escaped = sessionRef.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const prefixMatches = queryAll(
    db,
    "SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 2",
    `${escaped}%`
  );
  return prefixMatches.length === 1 ? stringValue(prefixMatches[0]?.id) : undefined;
}

function hasMessages(db: Database, sessionId: string): boolean {
  return !!queryOne(db, 'SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1', sessionId);
}

function latestCompressionChildId(db: Database, sessionId: string): string | undefined {
  const child = queryOne(
    db,
    `
      SELECT child.id
      FROM sessions child
      JOIN sessions parent ON parent.id = child.parent_session_id
      WHERE child.parent_session_id = ?
        AND parent.end_reason = 'compression'
        AND json_extract(COALESCE(child.model_config, '{}'), '$._branched_from') IS NULL
        AND json_extract(COALESCE(child.model_config, '{}'), '$._delegate_from') IS NULL
        AND COALESCE(child.source, '') != 'tool'
      ORDER BY child.started_at DESC, child.id DESC
      LIMIT 1
    `,
    sessionId
  );
  return stringValue(child?.id);
}

function resolveResumeSessionId(db: Database, sessionId: string): string {
  let current = sessionId;
  let best = hasMessages(db, current) ? current : undefined;
  const seen = new Set([current]);
  for (let depth = 0; depth < 32; depth += 1) {
    const childId = latestCompressionChildId(db, current);
    if (!childId || seen.has(childId)) break;
    seen.add(childId);
    current = childId;
    if (hasMessages(db, current)) best = current;
  }
  return best ?? sessionId;
}

function messagesViaDb(sessionRef: string): JsonRecord[] | undefined {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const resolved = resolveHermesSessionId(db, sessionRef);
    if (!resolved) return undefined;
    const sessionId = resolveResumeSessionId(db, resolved);
    return queryAll(
      db,
      `
        SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, reasoning_content
        FROM messages
        WHERE session_id = ? AND active = 1
        ORDER BY id ASC
      `,
      sessionId
    ).map(normalizeMessageRecord);
  } finally {
    db.close();
  }
}

async function loadHermesMessages(sessionRef: string): Promise<{ source: string; messages: JsonRecord[] } | null> {
  const api = await messagesViaApi(sessionRef);
  if (api) return { source: 'api', messages: api };
  const exported = await messagesViaExport(sessionRef);
  if (exported) return { source: 'export', messages: exported };
  const db = messagesViaDb(sessionRef);
  return db ? { source: 'db', messages: db } : null;
}

function capOutput(lines: string[], limitBytes: number): string {
  let output = '';
  for (const line of lines) {
    const next = output ? `${output}\n${line}` : line;
    if (Buffer.byteLength(next, 'utf8') > limitBytes) break;
    output = next;
  }
  return output;
}

export async function hermesHistoryPage(
  context: ExternalAgentProviderHistoryPageRequestContext
): Promise<ExternalAgentProviderHistoryPageContext['page'] | null> {
  const loaded = await loadHermesMessages(context.providerSessionRef);
  if (!loaded) return null;
  const page = sliceMessages(loaded.messages, {
    limit: context.request.limit,
    offset: pageOffset(context.request.before),
    desc: context.request.sortDirection === 'desc'
  });
  return { ...page, [HISTORY_SOURCE]: loaded.source } as ExternalAgentProviderHistoryPageContext['page'];
}

export function hermesHistoryPageOutput(context: ExternalAgentProviderHistoryPageContext): string | null {
  const lines = context.page.items.map((item) => JSON.stringify(item));
  return capOutput(lines, context.limitBytes) || null;
}
