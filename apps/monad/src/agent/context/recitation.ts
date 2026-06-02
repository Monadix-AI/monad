// Stage 3 of the context cascade: re-anchor the current plan after compaction. A durable summary is
// dense prose the model has to re-derive intent from every turn; pulling its "## Open Tasks" /
// "## Next Step" sections back out (see summary-structured-system.prompt.md, the section headers
// this parses) and pinning them near the end of the prompt keeps "what am I doing right now" from
// drifting once older turns are folded away. Pure text parsing only — rendering lives in prompts.ts.

export interface PlanSections {
  openTasks?: string;
  nextStep?: string;
}

function extractSection(summary: string, heading: string): string | undefined {
  // [ \t]* (not \s*) before the mandatory \n: \s* would also swallow a following blank line,
  // leaving no leading \n for the next heading's lookahead to anchor on — the body would then run
  // all the way to the NEXT heading after that one (or to the end) instead of stopping correctly.
  const re = new RegExp(`##\\s*${heading}[ \\t]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const body = summary.match(re)?.[1]?.trim();
  return body ? body : undefined;
}

/** Extract the Open Tasks / Next Step sections from a durable structured summary. Either or both
 *  may be absent (an omitted section, or a summary predating the structured format). */
export function parsePlanSections(summary: string): PlanSections {
  return {
    openTasks: extractSection(summary, 'Open Tasks'),
    nextStep: extractSection(summary, 'Next Step')
  };
}
