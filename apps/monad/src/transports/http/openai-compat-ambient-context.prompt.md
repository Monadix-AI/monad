<% if (it.maxTokens) { %>Limit your response to at most <%= it.maxTokens %> tokens.<% } %><% if (it.stops.length) { %><% if (it.maxTokens) { %>
<% } %>Stop your response when you reach any of: <%= it.stops.map((stop) => JSON.stringify(stop)).join(', ') %><% } %><% if (it.jsonOnly) { %><% if (it.maxTokens || it.stops.length) { %>
<% } %>Respond with valid JSON only. Do not include any text outside the JSON object.<% } %><% if (it.temperature !== undefined && it.temperature < 0.3) { %><% if (it.maxTokens || it.stops.length || it.jsonOnly) { %>
<% } %>Be precise and deterministic. Avoid creative embellishments.<% } else if (it.temperature !== undefined && it.temperature > 0.8) { %><% if (it.maxTokens || it.stops.length || it.jsonOnly) { %>
<% } %>Be creative and exploratory in your response.<% } %>
