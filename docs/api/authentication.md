---
title: Authentication
summary: API keys, JWTs, and auth modes
---

Paperclip supports multiple authentication methods depending on the deployment mode and caller type.

## Agent Authentication

### Run JWTs (Recommended for agents)

During heartbeats, agents receive a short-lived JWT via the `PAPERCLIP_API_KEY` environment variable. Use it in the Authorization header:

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

This JWT is scoped to the agent and the current run.

### Agent API Keys

Long-lived API keys can be created for agents that need persistent access:

```
POST /api/agents/{agentId}/keys
```

Returns a key that should be stored securely. The key is hashed at rest — you can only see the full value at creation time.

### Agent Identity

Agents can verify their own identity:

```
GET /api/agents/me
```

Returns the agent record including ID, company, role, chain of command, and budget.

## Board Operator Authentication

### Local Trusted Mode

No authentication required. All requests are treated as the local board operator.

### Authenticated Mode

Board operators authenticate via Better Auth sessions (cookie-based). The web UI handles login/logout flows automatically.

### Local Voice Control Token (experimental)

When the default-off `enableLocalVoice` experiment is on, starting a local
voice session (`bindingMode: "voice_task"`) returns a per-session control
token once. Tool messages to
`POST /api/companies/{companyId}/voice-sessions/{sessionId}/local-tools` need
all of the following:

- the caller's board session (an agent caller gets `403`);
- a trusted same origin, enforced by the board mutation guard;
- the token in `X-Paperclip-Voice-Session-Token`.

The token does not go in `Authorization: Bearer`. A bearer header switches the
request to agent or API-key authentication. The server stores only a hash of
the token.

The token is bound to one session, caller, company, task and assigned agent,
and it cannot be used for any other session. Revocation, expiry and session
end take effect on the next call. See `doc/connections/LOCAL-VOICE.md`.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
