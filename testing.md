# Testing Plan (Living Document)

Last Updated: 2026-02-27
Owner: Platform Engineering
Status: Active
Scope: `employee-slackbot`

## 1. Purpose

Define and track the testing strategy for the Slackbot + MCP gateway integration with clear release gates.

## 2. Testing Principles

1. Policy and security controls are tested first and continuously.
2. Tool allowlisting and role checks must pass before any feature rollout.
3. Prefer fast deterministic tests for PR gates; stage slower e2e tests in CI pipelines.

## 3. Test Layers

| Layer | Focus | Current Status | Gate |
|---|---|---|---|
| Unit | Validation, RBAC, policy gates, redaction, rate limit logic | in progress | required |
| Contract | Tool request/response schemas for allowlisted MCP tools | planned | required |
| Integration | Slackbot + OpenAI orchestration + MCP gateway interaction | planned | required |
| E2E | Staging Slack workspace scenarios | planned | required before prod |
| Security/Abuse | Signature tampering, replay, role escalation, prompt abuse | planned | required |
| Performance | p95 latency, error budgets under load | planned | required before full rollout |

## 4. Current Baseline

Initial committed tests:
1. Environment template verification (`tests/unit/env-template.test.js`)
2. Tool manifest validation (`tests/unit/allowed-tools-manifest.test.js`)

This baseline confirms required key configuration is present before functional code tests are added.

## 5. Minimum Required Scenarios

### 5.1 Slack Auth and Intake

1. Valid Slack signature accepted.
2. Invalid signature rejected.
3. Disallowed workspace/channel/user rejected.

### 5.2 Authorization and Tool Policy

1. User role resolves correctly.
2. Only role-allowed tools are exposed to OpenAI.
3. MCP re-validates and blocks unauthorized tool invocation.
4. High-risk tool requires explicit confirmation.

### 5.3 Safety and Data Handling

1. Phone/email redaction works in responses.
2. Sensitive fields are masked in audit logs.
3. Max input/output limits are enforced.

### 5.4 Reliability

1. MCP timeout returns safe user-facing error.
2. OpenAI failure path is handled without leaking internals.
3. Idempotency rules prevent duplicate mutating actions.

## 6. Commands

```bash
npm test
npm run test:watch
npm run check
```

## 7. CI Gates

1. `npm test` passes.
2. Security lint/scans have no critical or high findings.
3. Required staging smoke scenarios pass before production promotion.

## 8. Open Items

1. Select test runner strategy for integration/e2e (`node:test` only vs additional framework).
2. Finalize test fixtures for Slack events and MCP tool responses.
3. Define canary rollback test checklist.

## 9. Change Log

| Date | Author | Summary |
|---|---|---|
| 2026-02-27 | Platform Engineering | Initial living testing plan and baseline test setup |
