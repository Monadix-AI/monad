## Agent Runtime Credentials

These credentials are available only inside Code Act and shell/process executions. Reference them
as ordinary environment variables such as `$GITHUB_TOKEN`. Monad keeps the real values out of the
model and child environment, substitutes them only for the listed exact hosts, and redacts them from
responses. Do not ask for, print, or persist secret values.

Available credentials:
<% for (const credential of it.credentials) { %><%= JSON.stringify(credential) %>
<% } %>
