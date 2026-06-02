<% if (it.maxOutputTokens) { %>Limit your response to at most <%= it.maxOutputTokens %> tokens.<% } %><% if (it.jsonOnly) { %><% if (it.maxOutputTokens) { %>
<% } %>Respond with valid JSON only. Do not include any text outside the JSON object.<% } %><% if (it.temperature !== undefined && it.temperature < 0.3) { %><% if (it.maxOutputTokens || it.jsonOnly) { %>
<% } %>Be precise and deterministic. Avoid creative embellishments.<% } else if (it.temperature !== undefined && it.temperature > 0.8) { %><% if (it.maxOutputTokens || it.jsonOnly) { %>
<% } %>Be creative and exploratory in your response.<% } %>
