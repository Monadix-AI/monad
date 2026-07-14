New Workplace Project message is available.
Process this project message now.

Message metadata:
Sender kind: <%= it.senderKind %>
Sender name: <%= it.senderName %><% if (it.senderId) { %>
Sender id: <%= it.senderId %><% } %><% if (it.senderMention) { %>
Sender mention token: <%= it.senderMention %><% } %>

Project message body:
<%= it.text %>
