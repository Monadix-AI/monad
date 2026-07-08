import type { ModelRouter } from '#/agent/model/index.ts';
import type { Tool } from '#/capabilities/tools/types.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { toolInputJsonSchema } from '#/capabilities/tools/schema.ts';
import { getCatalog } from '#/capabilities/tools/tool-catalog.ts';
import { toolResult } from '#/capabilities/tools/types.ts';
// `with { type: 'file' }` embeds reliably in bun's --compile binary; `new URL(..., import.meta.url)`
// resolves against the bundled module's relocated path and breaks in the standalone binary.
import searchPromptPath from '../../../agent/prompts/tool-search-system-prompt.md' with { type: 'file' };

const log = createLogger('tool-search');

export interface ToolSearchDeps {
  model: ModelRouter;
  searchModelId: string;
  /** Live getter for all registered tools (used to look up schemas after the inner LLM returns names). */
  getTools: () => Tool[];
  /** Live getter for the current tool revision (for catalog cache keying). */
  getToolRevision: () => number;
  /** Tool names always exposed directly to the model — excluded from the deferrable catalog. */
  builtinToolNames: ReadonlySet<string>;
  /** Max tools to return per search. Default: 5. */
  topK?: number;
}

const SEARCH_PROMPT = (await Bun.file(searchPromptPath).text()).trim();

export function createToolSearchTool(deps: ToolSearchDeps): Tool<{ query: string }, string> {
  const topK = deps.topK ?? 5;

  return {
    name: 'tool_search',
    description:
      'Search the registered tool catalog to find tools relevant to a task. Returns matching tools with their full parameter schemas so you can then call them via tool_call. Use this when the tool you need is not in your current tool list.',
    scopes: [{ resource: 'internal:tool-search' }],
    highRisk: false,
    inputSchema: z.object({ query: z.string().min(1).describe('What you want to accomplish, in natural language') }),

    async run(input, ctx) {
      log.debug(
        { sessionId: ctx.sessionId, query: input.query, revision: deps.getToolRevision() },
        'tool_search invoked (deferred mode active)'
      );
      const allTools = deps.getTools();
      const deferrable = allTools.filter(
        (t) => !deps.builtinToolNames.has(t.name) && t.name !== 'tool_search' && t.name !== 'tool_call'
      );

      if (deferrable.length === 0) {
        return toolResult('No additional tools are registered in the catalog.');
      }

      const catalogText = getCatalog(deferrable, deps.getToolRevision());

      const result = await deps.model.complete({
        model: deps.searchModelId,
        messages: [
          { role: 'system', content: `${SEARCH_PROMPT}\n${catalogText}`, cache: true },
          {
            role: 'user',
            content: `Find tools relevant to: ${input.query}\nReturn at most ${topK} tool names, one per line, most relevant first.`
          }
        ]
      });

      // Parse response: one tool name per line, filter to names present in the registry.
      const toolMap = new Map(deferrable.map((t) => [t.name, t]));
      const matched = result.text
        .split('\n')
        .map((line) => line.trim())
        .filter((name) => toolMap.has(name))
        .slice(0, topK)
        .map((name) => toolMap.get(name) as Tool);

      if (matched.length === 0) {
        return toolResult(
          `No tools found matching "${input.query}". Try a different description or check if the capability is registered.`
        );
      }

      const sections = matched.map((tool) => {
        const schema = toolInputJsonSchema(tool);
        const params = schema ? JSON.stringify(schema, null, 2) : 'none';
        return `## ${tool.name}\n${tool.description}\nParameters:\n${params}`;
      });

      return toolResult(
        `Found ${matched.length} tool(s):\n\n${sections.join('\n\n---\n\n')}\n\nUse tool_call with the exact tool name and args to execute.`
      );
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<ToolSearchDeps> = (deps) => [createToolSearchTool(deps)];
