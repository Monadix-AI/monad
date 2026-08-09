New managed project message is available.
Review this room broadcast now.
A broadcast wake does not require a public reply. Reply only if you can add concrete task value; otherwise take no public action.

Message metadata:
Sender kind: <%= it.senderKind %>
Sender name: <%= it.senderName %><% if (it.senderId) { %>
Sender id: <%= it.senderId %><% } %><% if (it.senderMention) { %>
Sender mention token: <%= it.senderMention %><% } %>

Project message body:
<%= it.text %>
