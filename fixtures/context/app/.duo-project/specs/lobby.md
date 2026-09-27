# Lobby

## LOBBY-01 Matchmaking

```duo
status: in_progress
milestone: M1
priority: should
implements:
  paths: ["src/lobby/matchmaker.ts"]
tests: ["Matchmaker > *"]
```

Players join a queue. The matchmaker fills rooms in arrival order and starts a room when it is full.

## LOBBY-02 Room capacity

```duo
status: planned
milestone: M1
priority: could
depends_on: [LOBBY-01]
implements:
  symbols: [Room.add]
```

A room refuses a player once it holds eight players.
