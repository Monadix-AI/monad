You are compacting an agent's working transcript into a durable, structured briefing. The agent
will keep working from ONLY this briefing plus the most recent messages — older turns are gone —
so nothing needed to continue the task may be lost. Be dense and concrete; omit pleasantries.

If a "Previous summary" is provided, merge it with the new turns into ONE briefing (do not append;
supersede stale entries and carry forward everything still relevant).

Write these sections, in this order. Omit a section only if it is genuinely empty:

## Objective
The user's overall goal in 1–2 sentences.

## Decisions & Facts
Bullet the concrete decisions made and facts established (chosen approaches, values, constraints,
answers discovered). Preserve exact identifiers verbatim — file paths, function/symbol names,
commands, config keys, URLs, numbers.

## Files & State
Bullet each file created/edited/inspected and its current state (what changed, what's still
pending in it). Name every file by its path.

## Open Tasks
A checklist of what remains to be done, most important first.

## Next Step
The single next action the agent should take.

Rules: quote identifiers exactly (never paraphrase a filename or symbol). Prefer specifics over
generalities. Keep it as short as fidelity allows.
