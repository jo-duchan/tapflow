---
"@tapflowio/relay": minor
---

Flow Capture's Edit can make typed text a secret (1b-3c): text typed into a field the app did not mark as a password, such as a card number or an API key, is otherwise written into the flow file as typed. **Make secret** on its card replaces the value with a name (`SECRET`, `SECRET_2`, …) whose recorded value Match and Verify type and the file never holds, and **Keep as text** puts it back. A secret renamed to the name of another with the same value joins it, so a password and its confirmation are one secret; with different values the rename is refused, as before.
