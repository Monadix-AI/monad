import type { HookEvent } from '@monad/protocol';
import type { Connector, HookDefinition } from '@monad/sdk-atom';
import type { Tool } from '@/capabilities/tools/types.ts';

/** Collects tools/connectors/hooks registered by loaded atom packs — the daemon's host sink for the
 *  `tool`/`connector`/`hook` atom kinds (see createChannelRegistry). */
export class AtomPackRegistry {
  readonly tools = new Map<string, Tool>();
  readonly connectors = new Map<string, Connector>();
  readonly hooks = new Map<HookEvent, HookDefinition[]>();
  /** toolName → its source tag, so a rediscovery sweep can drop just the reloadable sources. */
  private readonly toolSources = new Map<string, string>();
  /** toolName → its specific origin name (atom-pack id / MCP server name), for per-agent atom
   *  allowlists (Studio). Distinct from `toolSources` (a coarse reloadable-kind tag); absent for built-ins. */
  private readonly toolSourceNames = new Map<string, string>();
  /** Monotonic tool-set revision + a cached array snapshot, so the agent's per-turn tool getter can
   *  memoize on `toolRevision` and reuse `toolList()`'s reference — no per-turn rebuild when nothing
   *  was installed/removed (the common case). Both are invalidated on any tool-set change. */
  private rev = 0;
  private cachedList: Tool[] | null = null;

  /** Bumps whenever the tool SET changes (install/remove/re-register). */
  get toolRevision(): number {
    return this.rev;
  }

  /** Stable array snapshot — rebuilt only when the set changes, so per-turn reads reuse a reference. */
  toolList(): Tool[] {
    if (this.cachedList === null) this.cachedList = [...this.tools.values()];
    return this.cachedList;
  }

  /** `source` tags where a tool came from so it can be selectively cleared on a rediscovery sweep:
   *  'atom-pack' / 'file-mcp' are re-scanned and cleared; the default 'static' (builtin, config.json
   *  MCP, obscura) is boot-once and never cleared. */
  registerTool(tool: Tool, source = 'static', sourceName?: string): void {
    this.tools.set(tool.name, tool);
    this.toolSources.set(tool.name, source);
    if (sourceName !== undefined) this.toolSourceNames.set(tool.name, sourceName);
    this.rev++;
    this.cachedList = null;
  }

  /** The tool's specific origin name (atom-pack id / MCP server name), or undefined for a built-in.
   *  Used by the per-agent atom allowlist to decide exposure (see Studio `isToolExposed`). */
  sourceNameOf(toolName: string): string | undefined {
    return this.toolSourceNames.get(toolName);
  }

  /** Drop every tool registered under `source` so an UNINSTALLED atom pack / MCP server's tools
   *  don't linger after a rediscovery sweep re-adds only the survivors. The agent reads tools live,
   *  so the removal takes effect on its next turn — no restart. */
  clearToolsFrom(source: string): void {
    let changed = false;
    for (const [name, src] of this.toolSources) {
      if (src !== source) continue;
      this.tools.delete(name);
      this.toolSources.delete(name);
      this.toolSourceNames.delete(name);
      changed = true;
    }
    if (changed) {
      this.rev++;
      this.cachedList = null;
    }
  }

  registerConnector(connector: Connector): void {
    this.connectors.set(connector.name, connector);
  }

  registerHook(hook: HookDefinition): void {
    const list = this.hooks.get(hook.event) ?? [];
    list.push(hook);
    this.hooks.set(hook.event, list);
  }

  /** Drop all registered hooks. Used before a re-discovery sweep so a removed atom pack's hooks
   *  don't linger (the sweep re-adds the surviving packs' hooks). The HookRunner reads this Map
   *  live per event, so the refresh takes effect without a restart. */
  clearHooks(): void {
    this.hooks.clear();
  }
}
