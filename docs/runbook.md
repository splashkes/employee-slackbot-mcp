# Employee AI Runbook

Last Updated: 2026-02-27
Owner: Platform Engineering

## 1. Services

1. `slackbot` (port `3000`)
2. `mcp-gateway` (port `8081`)

## 2. Health Checks

### Slackbot

```bash
curl -sS http://localhost:3000/healthz
curl -sS http://localhost:3000/readyz
```

### MCP Gateway

```bash
curl -sS http://localhost:8081/healthz
curl -sS http://localhost:8081/readyz
```

## 3. Local Startup

### Slackbot

```bash
cd services/slackbot
npm install
npm run start
```

### MCP Gateway

```bash
cd services/mcp-gateway
npm install
npm run start
```

## 4. Verify MCP Connectivity

```bash
curl -sS \
  -H "Authorization: Bearer $MCP_GATEWAY_AUTH_TOKEN" \
  http://localhost:8081/v1/tools
```

## 5. Common Incidents

### 5.1 Slackbot returns access denied

Checks:
1. Confirm `SLACK_ALLOWED_TEAM_IDS`, `SLACK_ALLOWED_CHANNEL_IDS`, and `SLACK_ALLOWED_USER_IDS`.
2. Confirm `RBAC_USER_MAP_JSON` includes the requester.

### 5.2 Tool execution fails with `tool_not_allowed_for_role`

Checks:
1. Confirm `config/allowed-tools.json` includes the role for the tool.
2. Confirm the user role mapping resolves to expected role.

### 5.3 High-risk tool fails with `confirmation_required`

Checks:
1. Include explicit `CONFIRM` in Slack request text.
2. Confirm `ENABLE_MUTATING_TOOLS=true` in the active environment if writes are intended.

### 5.4 MCP auth failures

Checks:
1. Confirm both services use the same `MCP_GATEWAY_AUTH_TOKEN`.
2. Confirm Authorization header value is `Bearer <token>`.

## 6. Secret Rotation

1. Update `employee-ai-secrets` values in secret manager or Kubernetes secret.
2. Restart deployments:

```bash
kubectl rollout restart deploy/slackbot -n artbattle-employee-ai
kubectl rollout restart deploy/mcp-gateway -n artbattle-employee-ai
```

3. Validate health and a sample low-risk tool request.

## 7. Emergency Read-Only Mode

To disable high-risk writes quickly:
1. Set `ENABLE_MUTATING_TOOLS=false`.
2. Roll out restart for both services.
3. Confirm high-risk tools are blocked.
