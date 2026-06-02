// Parse a Claude Code subagent markdown file into the fields monad's createAgent accepts. Claude Code
// subagents are a markdown body with a leading YAML frontmatter fence:
//
//   ---
//   name: code-reviewer
//   description: Use right after writing code, to review for quality.
//   model: sonnet            # optional
//   tools: Read, Grep, Bash  # optional — NOT imported (Claude built-in tool names don't map to
//                            #   monad's pack/MCP atoms.allow; capabilities are configured in monad)
//   ---
//   <system prompt body>
//
// We import the persona + metadata (name/description/model + body). Tool grants are intentionally left
// for the user to set in monad's own capability model (exposure ⊆ registration).

export interface ImportedAgent {
  name: string;
  description?: string;
  model?: string;
  prompt: string;
}

/** Unquote a scalar YAML value ('x' / "x" / x) and trim a trailing line comment on unquoted values. */
function scalar(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  const hash = v.indexOf(' #');
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/** Parse the subagent markdown. Throws with a human-readable reason when it isn't importable. */
export function parseClaudeSubagent(md: string): ImportedAgent {
  const text = md.replace(/^﻿/, '').trimStart();
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!fence) throw new Error('No YAML frontmatter found (expected a leading --- … --- block).');

  const front = fence[1] ?? '';
  const body = text.slice(fence[0].length).trim();

  const fields: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m?.[1]) fields[m[1].toLowerCase()] = scalar(m[2] ?? '');
  }

  const name = fields.name;
  if (!name) throw new Error('Frontmatter is missing a required "name" field.');

  return {
    name,
    description: fields.description || undefined,
    model: fields.model || undefined,
    prompt: body
  };
}
