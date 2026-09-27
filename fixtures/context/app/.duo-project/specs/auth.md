# Authentication

## AUTH-01 Login

```duo
status: done
milestone: M1
priority: must
implements:
  symbols: [AuthService.login]
tests: ["AuthService > login*"]
```

Users sign in with an email address and a password. A successful login returns an access token
and a refresh token.

## AUTH-03 Refresh Token

```duo
status: planned
milestone: M1
priority: must
depends_on: [AUTH-01]
implements:
  symbols: [AuthService.refresh, TokenStore.rotate]
tests: ["AuthService > refresh*"]
```

When the access token expires, the client sends its refresh token and receives a new access token.
An unknown or revoked refresh token is rejected with an authentication error.

Access tokens live 15 minutes and refresh tokens 14 days.
