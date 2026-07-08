// Uniform tool-module contract. EVERY tool module — static (fs, shell), service (memory, schedule),
// and agent-runtime (delegate, vision, tool_search, …) — exposes the SAME entry: a
// `register: ToolModule<Deps>` factory that takes its dependency bag and returns the ready Tool[].
// The shape is uniform; the deps type is parameterized so a module declares exactly what it needs
// instead of every tool sharing one god-bag:
//   - static modules     → `ToolModule` (= ToolModule<ToolDeps>); they ignore deps
//   - service modules     → `ToolModule` and destructure from the daemon ToolDeps
//   - agent-runtime mods  → `ToolModule<ItsOwnDeps>` over bootstrap-local deps (model, gate, …)
// Conditional modules `return []` when a needed dep is absent (the tool is simply not advertised);
// reflexive modules read a `getTools` thunk for the live registry. One idiom, one assembly helper.
//
// `ToolDeps` fields are all optional: the assembly point may run before every service exists (e.g.
// the static builtins are composed at module load with no deps), and a module that needs a missing
// dep returns [].

import type { Tool } from '#/capabilities/tools/types.ts';
import type { NoteStore } from './memory.ts';
import type { Scheduler } from './schedule.ts';

export interface ToolDeps {
  /** Session-scoped note backend for the memory_* tools. */
  notes?: NoteStore;
  /** Daemon ScheduleService surface for the schedule_* tools. */
  scheduler?: Scheduler;
}

/** The uniform entry shape for a tool module, parameterized by the deps that module needs. */
export type ToolModule<Deps = ToolDeps> = (deps: Deps) => Tool[];

/** Unwrap a single-tool module's result — for the few call sites that need the one Tool directly
 * (e.g. tool_search / tool_call are referenced by identity in the agent's toolSearchConfig). */
export function only(tools: Tool[]): Tool {
  const [tool] = tools;
  if (!tool) throw new Error('tool module produced no tool');
  return tool;
}

/** Compose modules into a deduped tool list (last write wins on name collision). */
export function buildTools<Deps>(modules: ToolModule<Deps>[], deps: Deps): Tool[] {
  const byName = new Map<string, Tool>();
  for (const register of modules) for (const tool of register(deps)) byName.set(tool.name, tool);
  return [...byName.values()];
}
