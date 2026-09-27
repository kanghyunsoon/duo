# Architecture

The backend is one Node.js process with three areas.

## Accounts

Players sign in with an email address and a password. The server issues a short-lived access
token and an opaque refresh token. Refresh tokens are stored on the server so that an operator can
revoke every session of a player. The HTTP layer calls AuthService for login, refresh and logout.

## Lobby

Players enter a queue. The matchmaker takes players in arrival order and fills rooms. A room
starts when it is full. Rooms are kept in memory; a restart drops every waiting player, which is
acceptable for the first milestone.

## Match simulation

The simulation advances rigid bodies with a fixed time step, resolves collisions and keeps bodies
inside the arena. Inventory and crafting run on the same tick. Scores are computed at the end of a
match and feed the season leaderboard and the Elo ratings used for balancing.

## Operations

Configuration comes from environment variables. Audit lines are JSON on stdout; they must never
contain tokens or passwords. Metrics and tracing are outside the first milestone.

## Open questions

- Should the match simulation be server-authoritative?
- How long should a disconnected player keep their room slot?
- Do we need regional lobbies before the public beta?
