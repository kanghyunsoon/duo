# Auth

## AUTH-03 Refresh Token

```duo
status: in_progress
milestone: M1
priority: must
implements:
  symbols: [TokenService.refresh]
tests: ["TokenService > refresh*"]
```

An expired access token is renewed with a refresh token. Tokens are stateless: the server keeps no session store.
