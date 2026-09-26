---
'@tapflowio/relay': minor
---

Relay authentication is tightened in four places.

- `GET /api/v1/logs` answers only the relay's own host. Another machine, the tunnel listener, and a remote client behind a trusted proxy get `403` telling them to run `tapflow logs` on the relay host, signed in or not. `?lines=` is now an integer from 1 to 500 (100 when absent or not a number).
- A remote WebSocket that authenticates with a personal access token needs the `view` scope to open device sessions; a token without it is closed with 1008 and a reason naming the scope. An `agent`-only token can no longer act as a browser by sending something other than a handshake first.
- An `agent`-scope token works only while its owner is an Admin. The handshake refuses it otherwise (1008, with a reason telling an Admin to issue a new one), a `view,agent` token of a non-Admin owner may still browse but not register an agent, and the relay logs at start how many agent tokens are affected.
- The session cookie is checked against the users table on every use, so a removed member is refused everywhere at once — every HTTP route, `/uploads`, recordings, and the WebSocket handshake — instead of until the 7-day cookie expired. Open WebSockets are re-checked on the 30-second heartbeat and right after a member is removed or has their role changed, a token is revoked, or an invitation is accepted for an existing account: a socket whose member, token or cookie is no longer valid, or has expired, is closed with 1008, and an agent closed this way ends its sessions at once instead of holding them for the reconnect grace.

A token's "last used" time now moves only when the relay accepts it, and a refused WebSocket is logged with its reason, once per token per minute. A database error while authenticating a WebSocket or an `/uploads` request closes that one connection (1011) or answers 500 instead of stopping the relay.
