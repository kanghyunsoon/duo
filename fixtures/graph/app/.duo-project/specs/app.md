# App

## APP-01 Login

```duo
status: in_progress
milestone: M1
priority: must
implements:
  symbols: [login]
tests: ["App > logs*"]
```

Users log in.

## APP-02 Session

```duo
status: planned
milestone: M1
priority: should
depends_on: [APP-01]
implements:
  paths: ["src/auth/session.ts"]
```

Sessions survive a reload.
