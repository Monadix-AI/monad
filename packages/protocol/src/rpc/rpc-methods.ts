// JSON-RPC view of the method table. The wire flattens each method's `path` + `query` +
// `body` into one flat params object; `result` is the response. Everything here is
// DERIVED from METHOD_TABLE (method-table.ts) — the single source of truth — so the RPC
// and HTTP transports cannot drift. All three NDJSON transports (WebSocket / Unix socket /
// stdio) validate params against `RPC_METHOD_PARAMS` identically.

import { z } from 'zod';

import { METHOD_TABLE, type MethodDef, type MethodName } from './method-table.ts';

export type RpcMethod = MethodName;

type Def<M extends RpcMethod> = (typeof METHOD_TABLE)[M];

// `unknown` is the no-contribution identity for intersection (`A & unknown = A`),
// so a method missing `path`, `query`, or `body` simply adds nothing to its flat params.
type PathParams<M extends RpcMethod> =
  Def<M> extends { path: infer P } ? { [K in keyof P]: P[K] extends z.ZodType ? z.infer<P[K]> : never } : unknown;
type QueryParams<M extends RpcMethod> =
  Def<M> extends { query: infer Q } ? (Q extends z.ZodType ? z.infer<Q> : unknown) : unknown;
type BodyParams<M extends RpcMethod> =
  Def<M> extends { body: infer B } ? (B extends z.ZodType ? z.infer<B> : unknown) : unknown;

/** Flat JSON-RPC params: the method's path, query, and body fields merged. */
export type RpcParams<M extends RpcMethod> = PathParams<M> & QueryParams<M> & BodyParams<M>;
export type RpcResult<M extends RpcMethod> = z.infer<Def<M>['result']>;

/** Build the flat params validation schema for one method (path ⊕ query ⊕ body). */
function paramsSchemaOf(def: MethodDef): z.ZodType {
  const base = def.path ? z.object(def.path) : z.object({});
  const withQuery = def.query ? base.extend(def.query.shape) : base;
  return def.body ? withQuery.extend(def.body.shape) : withQuery;
}

/** Params-only view, used by the dispatch-time validation hot path in every transport. */
export const RPC_METHOD_PARAMS = Object.fromEntries(
  Object.entries(METHOD_TABLE).map(([method, def]) => [method, paramsSchemaOf(def)])
) as { [M in RpcMethod]: z.ZodType<RpcParams<M>> };

export function isRpcMethod(method: string): method is RpcMethod {
  return Object.hasOwn(METHOD_TABLE, method);
}
