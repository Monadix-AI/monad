<% if (it.mem0Facts.length) { %>What you know (from memory):
<% for (const fact of it.mem0Facts) { %>- <%= fact %>
<% } %><% } %><% if (it.globalFacts.length) { %><% if (it.mem0Facts.length) { %>

<% } %>What you know about the user:
<% for (const fact of it.globalFacts) { %>- <%= fact %>
<% } %><% } %><% if (it.projectFacts.length) { %><% if (it.mem0Facts.length || it.globalFacts.length) { %>

<% } %>What you know about this workspace:
<% for (const fact of it.projectFacts) { %>- <%= fact %>
<% } %><% } %><% if (it.privateFactCount) { %><% if (it.mem0Facts.length || it.globalFacts.length || it.projectFacts.length) { %>

<% } %>You also have <%= it.privateFactCount %> private memory note(s) for this agent — read them with the memory tool (action "view", scope "agent").<% } %><% if (it.laws.length) { %><% if (it.mem0Facts.length || it.globalFacts.length || it.projectFacts.length || it.privateFactCount) { %>

<% } %>Learned rules (general, follow these):
<% for (const law of it.laws) { %>- <%= law %>
<% } %><% } %>
