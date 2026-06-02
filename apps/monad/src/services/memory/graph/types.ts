// L2 knowledge-graph contracts. In-process only (no wire boundary yet) → plain TS, no zod.
// The provider interface lets the self-built SQLite store be swapped for a vendor graph later.

/** Isolation scope for a node/edge. v1 only writes `agent:<id>`; reads may include `global`. */
export type GraphScope = string;

type ProvClass = 'machine' | 'user';

export interface GraphNodeInput {
  scope: GraphScope;
  name: string;
  type?: string;
  aliases?: string[];
  attrs?: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  scope: GraphScope;
  name: string;
  type: string | null;
  aliases: string[];
  attrs: Record<string, unknown>;
  updatedAt: number;
}

export interface GraphEdgeInput {
  scope: GraphScope;
  /** Source/target node ids (from upsertNode). */
  src: string;
  dst: string;
  relation: string;
  provClass: ProvClass;
  /** messageIds this edge was extracted from — anchors deletion reconciliation. */
  support: string[];
  confidence: number;
}

export interface GraphEdge {
  id: string;
  scope: GraphScope;
  src: string;
  dst: string;
  relation: string;
  provClass: ProvClass;
  support: string[];
  confidence: number;
  validFrom: number;
  validTo: number | null;
}

/**
 * L2 graph backend. The default is the self-built SQLite store; a vendor (Zep/Graphiti/Cozo) can
 * implement the same surface behind it. Upserts merge idempotently (see store.ts).
 */
export interface L2Provider {
  /** Insert-or-merge a node by (scope, normalized name); returns its stable id. */
  upsertNode(n: GraphNodeInput): string;
  /** Insert-or-extend the current edge for (scope, src, dst, relation, provClass); returns its id. */
  upsertEdge(e: GraphEdgeInput): string;

  /** Lexical (FTS) match over node name/aliases within scope(s), current nodes only. */
  searchNodes(scopes: GraphScope[], query: string, limit?: number): GraphNode[];
  /** Resolve one node by exact (normalized) name within scope(s). */
  getNode(scopes: GraphScope[], name: string): GraphNode | null;
  /** Resolve nodes by id (e.g. to name the far endpoints of an edge). */
  nodesByIds(ids: string[]): GraphNode[];
  /** Current (validTo IS NULL) edges incident to a node. */
  edgesFor(nodeId: string): GraphEdge[];
  /** Current edges whose src AND dst are both in the given node-id set (the "paths between them"). */
  edgesAmong(nodeIds: string[]): GraphEdge[];
  /** Every node + every current edge (for the read-only graph viewer). */
  snapshot(): { nodes: GraphNode[]; edges: GraphEdge[] };

  /** Drop support messageIds for which `isAlive` is false; retract edges left with empty support. */
  reconcile(isAlive: (messageId: string) => boolean): { prunedEdges: number };

  getCursor(sessionId: string): string | null;
  setCursor(sessionId: string, throughMessageId: string): void;
  dropCursor(sessionId: string): void;
  knownSessions(): string[];

  close(): void;
}
