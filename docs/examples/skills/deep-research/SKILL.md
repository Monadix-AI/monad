---
name: deep-research
description: Investigate a topic thoroughly and report findings with sources. Use for open-ended, multi-step research that would otherwise flood the main conversation with intermediate searches.
context: fork
tier: power
metadata:
  author: monad-examples
  version: "1.0"
---

# Deep research

Research **$ARGUMENTS** thoroughly, then report back.

This skill runs as an isolated subagent (`context: fork`): all the intermediate searching,
reading, and note-taking happens in a fresh context, and only your final report returns to the
main conversation. Because the work is reasoning-heavy, it declares `tier: power` — the routing
layer runs it on the most capable model among the configured profiles (falling back to the
default if none is configured for that tier).

Approach:

1. Break the question into 3–5 concrete sub-questions.
2. Investigate each, preferring primary sources; note where sources disagree.
3. Synthesize a single answer — lead with the conclusion, then the supporting evidence.
4. End with a **Sources** list. Flag anything you could not verify rather than guessing.

Keep the final report tight: the caller wants the conclusion and its basis, not a transcript
of the search.
