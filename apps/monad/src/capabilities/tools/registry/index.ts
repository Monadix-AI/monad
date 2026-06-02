// @/capabilities/tools/registry — assembly home for built-in tool modules. Each module lives one level deep
// here and exposes the uniform `register: ToolModule` entry (see contract.ts); infra (types,
// security, schema, …) stays at @/capabilities/tools root. We import modules as namespaces (not `export *`)
// precisely because every module exports a symbol named `register` — a flat re-export would
// collide. The manifests below group modules by how they're assembled; the root tools/index.ts
// composes the public API from `buildTools(staticModules, {})`.

import type { Tool } from '../types.ts';

import * as codeExec from './code-exec.ts';
import { buildTools, type ToolDeps, type ToolModule } from './contract.ts';
import * as email from './email/index.ts';
import * as fs from './fs.ts';
import * as memory from './memory.ts';
import * as net from './net.ts';
import * as process from './process.ts';
import * as schedule from './schedule.ts';
import * as shell from './shell.ts';
import * as todo from './todo.ts';
import * as webExtract from './web-extract.ts';
import * as webSearch from './web-search.ts';

/** Modules that need no boot dependencies — composed at module load into `builtinTools`. */
const staticModules: ToolModule[] = [
  fs.register,
  shell.register,
  process.register,
  codeExec.register,
  net.register,
  webSearch.register,
  webExtract.register,
  todo.register,
  email.register
];

/** Service modules — composed at their boot call site with a populated ToolDeps (see main.ts). */
const serviceModules: ToolModule[] = [memory.register, schedule.register];

/** The static built-in tool set (no deps). */
export const builtinTools: Tool[] = buildTools(staticModules, {});

/** Compose service-tier tools (memory, schedule) from the daemon's runtime deps. */
export function buildServiceTools(deps: ToolDeps): Tool[] {
  return buildTools(serviceModules, deps);
}
