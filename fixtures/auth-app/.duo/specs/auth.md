# Authentication

## AUTH-01 Login

```duo
status: done
milestone: M1
priority: must
implements:
  paths: ["src/auth/**"]
  symbols: [AuthService.login]
tests: ["AuthService > login*"]
```

A user logs in with email and password and receives an access token and a refresh token.

## AUTH-03 Refresh Token

```duo
status: planned
milestone: M1
priority: must
depends_on: [AUTH-01]
implements:
  symbols: [AuthService.refresh]
```

When the access token expires, the client exchanges the refresh token for a new access token.

UNKNOWN: Refresh token lifetime
