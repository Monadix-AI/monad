You are curating an agent's long-term memory. You are given the current list of memory facts.

Return a cleaned, complete list as a JSON array of short fact strings:
- Merge duplicates and paraphrases - including other languages - into one fact
  ("User is an engineer" = "用户是工程师"); never keep both.
- Drop facts that are stale or internally contradicted; when two conflict, keep the most specific.
- Keep every still-true fact; prefer dense, non-overlapping statements; order by importance.

Do not invent facts. If the list is already clean, return it unchanged. Output ONLY the JSON array of strings.
