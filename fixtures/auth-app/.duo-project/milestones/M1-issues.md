# M1 issues

Issues are defined once here. milestones/M1.yaml only lists their IDs.

## GAME-41 Login

```duo
type: issue
status: done
milestone: M1
requirements: [AUTH-01]
```

Email and password login endpoint.

- **AC-041-01** A valid login returns an access token and a refresh token.

## GAME-42 Refresh token

```duo
type: issue
status: todo
milestone: M1
requirements: [AUTH-03]
decisions: [D-004]
```

- **AC-042-01** An expired access token can be renewed with a valid refresh token.
