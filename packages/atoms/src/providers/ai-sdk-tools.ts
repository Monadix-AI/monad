import type { ModelCall, ToolCall, ToolSpec } from '@monad/sdk-atom';
import type { ToolSet } from 'ai';

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { jsonSchema, tool } from 'ai';

function allowsProviderNativeSearch(provider: ModelCall['searchToolProvider']): boolean {
  return provider === undefined || provider === 'auto' || provider === 'native';
}

/** Build the AI SDK tool set for native function-calling. No `execute`: the model returns
 *  tool-calls and stops; the loop owns execution (approval gate, persistence, events).
 *  Provider-native hints (computer-use, web_search) emit the provider's built-in tool spec
 *  instead of a generic function tool; server-side tools (web_search, webSearchPreview) are
 *  executed by the provider — the loop persists their steps but skips local execution. */
export function buildSdkTools(
  tools: ToolSpec[] | undefined,
  providerType: string,
  searchToolProvider?: ModelCall['searchToolProvider']
): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    const anthropicHint = providerType === 'anthropic' ? t.providerTool?.anthropic : undefined;
    if (anthropicHint) {
      if (
        allowsProviderNativeSearch(searchToolProvider) &&
        (anthropicHint.type === 'web_search_20250305' || anthropicHint.type === 'web_search_20260209')
      ) {
        const opts = {
          ...(anthropicHint.maxUses !== undefined ? { maxUses: anthropicHint.maxUses } : {}),
          ...(anthropicHint.allowedDomains ? { allowedDomains: anthropicHint.allowedDomains } : {}),
          ...(anthropicHint.blockedDomains ? { blockedDomains: anthropicHint.blockedDomains } : {})
        };
        set[t.name] =
          anthropicHint.type === 'web_search_20260209'
            ? anthropic.tools.webSearch_20260209(opts)
            : anthropic.tools.webSearch_20250305(opts);
        continue;
      }
      // computer-use: client-executed tool with display dimensions (narrowed via discriminant)
      if (anthropicHint.type === 'computer_20250124' || anthropicHint.type === 'computer_20251124') {
        const opts = {
          displayWidthPx: anthropicHint.displayWidthPx,
          displayHeightPx: anthropicHint.displayHeightPx,
          ...(anthropicHint.displayNumber !== undefined ? { displayNumber: anthropicHint.displayNumber } : {})
        };
        set[t.name] =
          anthropicHint.type === 'computer_20251124'
            ? anthropic.tools.computer_20251124({ ...opts, ...(anthropicHint.enableZoom ? { enableZoom: true } : {}) })
            : anthropic.tools.computer_20250124(opts);
        continue;
      }
    }
    const openaiHint = providerType === 'openai' ? t.providerTool?.openai : undefined;
    if (allowsProviderNativeSearch(searchToolProvider) && openaiHint?.type === 'web_search_preview') {
      set[t.name] = openai.tools.webSearchPreview(
        openaiHint.searchContextSize ? { searchContextSize: openaiHint.searchContextSize } : {}
      );
      continue;
    }
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters ?? { type: 'object', properties: {} })
    });
  }
  return set;
}

/** True when the tool spec declares a provider-executed (server-side) binding for providerType.
 *  Used to flag tool calls returned from generateText so runToolLoop skips local execution. */
function isProviderNativeTool(
  spec: ToolSpec,
  providerType: string,
  searchToolProvider?: ModelCall['searchToolProvider']
): boolean {
  if (!allowsProviderNativeSearch(searchToolProvider)) return false;
  if (providerType === 'anthropic') {
    const h = spec.providerTool?.anthropic;
    return h?.type === 'web_search_20250305' || h?.type === 'web_search_20260209';
  }
  if (providerType === 'openai') {
    return spec.providerTool?.openai?.type === 'web_search_preview';
  }
  return false;
}

export function toModelToolCalls(
  calls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }> | undefined,
  toolSpecs: ToolSpec[] | undefined,
  providerType: string,
  searchToolProvider?: ModelCall['searchToolProvider']
): ToolCall[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((c) => {
    const spec = toolSpecs?.find((s) => s.name === c.toolName);
    const providerExecuted = spec ? isProviderNativeTool(spec, providerType, searchToolProvider) : false;
    return {
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input,
      ...(providerExecuted ? { providerExecuted: true } : {})
    };
  });
}
