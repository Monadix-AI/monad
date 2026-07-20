// One multiplexed WebSocket per client carries long-lived control streams: session-list lifecycle,
// stream markers, and host interaction notifications. Per-session generation is streamed over SSE
// (see docs/internals/realtime-channels.md), and all other request/response goes over REST.

import type { Event, InteractionEvent, RpcMethod, RpcParams } from '@monad/protocol';

import { eventNotificationSchema } from '@monad/protocol';

export type EventHandler = (event: Event) => void;
export type InteractionEventHandler = (event: InteractionEvent) => void;

/** Reconnect backoff schedule (ms), clamped to the last entry. */
const BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;

export class EventSocket {
  private ws?: WebSocket;
  private connecting = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  private readonly controlHandlers = new Set<EventHandler>();
  private readonly interactionHandlers = new Set<InteractionEventHandler>();

  constructor(private readonly url: string) {}

  subscribeControl(onEvent: EventHandler): () => void {
    const first = this.totalHandlers() === 0;
    this.controlHandlers.add(onEvent);
    if (first) this.openAndSubscribe();
    return () => {
      this.controlHandlers.delete(onEvent);
      this.unsubscribeIfIdle();
    };
  }

  subscribeInteractions(onEvent: InteractionEventHandler): () => void {
    const first = this.totalHandlers() === 0;
    this.interactionHandlers.add(onEvent);
    if (first) this.openAndSubscribe();
    return () => {
      this.interactionHandlers.delete(onEvent);
      this.unsubscribeIfIdle();
    };
  }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.controlHandlers.clear();
    this.interactionHandlers.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  private ensureOpen(): void {
    if (this.closed || this.ws || this.connecting) return;
    this.connecting = true;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.resubscribeAll();
    });
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    ws.addEventListener('close', () => this.onClose(ws));
    ws.addEventListener('error', () => ws.close());
  }

  private resubscribeAll(): void {
    if (this.totalHandlers() > 0) this.send({ method: 'control.subscribe', params: {} });
  }

  private onMessage(ev: MessageEvent): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(ev.data));
    } catch {
      return; // malformed frame — never throw out of the socket message handler
    }
    const parsed = eventNotificationSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.method === 'sessions.event') {
      for (const handler of this.controlHandlers) handler(msg.params.event);
      return;
    }
    if (msg.method === 'interactions.event') {
      for (const handler of this.interactionHandlers) handler(msg.params.event);
    }
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return; // stale close event from a superseded socket
    this.ws = undefined;
    this.connecting = false;
    if (this.closed || this.totalHandlers() === 0) return;

    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.ensureOpen(), delay);
  }

  private closeIfIdle(): void {
    if (this.totalHandlers() === 0) {
      this.ws?.close();
      this.ws = undefined;
    }
  }

  private totalHandlers(): number {
    return this.controlHandlers.size + this.interactionHandlers.size;
  }

  private openAndSubscribe(): void {
    this.ensureOpen();
    this.send({ method: 'control.subscribe', params: {} });
  }

  private unsubscribeIfIdle(): void {
    if (this.totalHandlers() === 0) {
      this.send({ method: 'control.unsubscribe', params: {} });
      this.closeIfIdle();
    }
  }

  private send<M extends RpcMethod>(req: { method: M; params: RpcParams<M> }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return; // resubscribeAll replays on reconnect
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: req.method, params: req.params }));
  }
}
