# MCP Remote CLI over SSH Plan

Date: 2026-02-27
Owner: Platform Engineering
Status: Proposed
Scope: Enable MCP tools to run tightly-controlled `psql` and `supabase` CLI operations via SSH on approved remote servers.

## 1. Objective

Allow employee Slack workflows to execute a limited set of remote operational commands (`psql`, `supabase`) through MCP while preserving strong security controls, auditability, and blast-radius limits.

## 2. Why Current Setup Is Not Sufficient

Current scaffold gaps:
1. MCP gateway executes stub functions only (no SSH/CLI runtime path).
2. Gateway image lacks required binaries (`ssh`, `psql`, `supabase`).
3. K8s network policy does not allow outbound SSH (TCP/22) to approved hosts.
4. Secrets template has no SSH credentials, host pinning, or remote profile config.
5. No remote command templates, argument validation, or execution sandbox.

## 3. Security Design Principles

1. No arbitrary shell execution from user prompts.
2. Allowlist-only tools and allowlist-only command templates.
3. Bastion-first model: SSH only to approved bastion(s), then controlled command execution.
4. Host key pinning (`known_hosts`) is mandatory.
5. Per-tool RBAC + risk-level confirmation for sensitive actions.
6. Least privilege remote account with read-only defaults.
7. Full audit trail: requester, role, tool, arguments hash, target host profile, exit code, duration.

## 4. Target Architecture

## 4.1 Request Flow

1. User request arrives in Slackbot.
2. Slackbot applies identity/RBAC/tool allowlist checks.
3. Slackbot calls MCP gateway tool endpoint.
4. MCP gateway resolves tool -> command template -> approved remote profile.
5. MCP gateway validates parameters against strict schema.
6. MCP gateway executes SSH command (non-interactive, timeout bounded, no TTY) on bastion/target.
7. Remote command runs `psql` or `supabase` with a controlled template.
8. MCP gateway returns sanitized result and logs structured audit event.

## 4.2 Components To Add

1. `services/mcp-gateway/src/remote_exec.js`
- SSH command runner with timeout and output size limit.
- Known-host validation and key-based auth.

2. `config/remote-command-templates.json`
- Static mapping from tool names to safe command templates.
- Each template includes risk level, profile binding, timeout, and output limits.

3. `config/remote-host-profiles.json`
- Profile definitions (`bastion_finance`, `bastion_ops`, etc.).
- Host, user, port, strict host key policy, environment restrictions.

4. K8s secret additions
- private key
- known_hosts
- optional jump-host config
- remote CLI auth tokens if needed (scoped)

## 5. Tool Model (No Arbitrary Command)

Tools should map to pre-approved operations only.

Initial candidate tools:
1. `remote_psql_read_query`
- Risk: medium
- Allowed roles: ops, finance
- Query source: pre-approved named query key OR parameterized query template only

2. `remote_supabase_status`
- Risk: low
- Allowed roles: ops
- Command template fixed to status/health subcommands

3. `remote_supabase_migration_list`
- Risk: medium
- Allowed roles: ops
- Read-only migration inspection commands

4. `remote_psql_payment_audit`
- Risk: high (data sensitivity)
- Allowed roles: finance
- Confirmation required

Explicitly out of scope initially:
1. Generic `remote_shell_exec`.
2. Unbounded SQL from free text.
3. Write/DDL operations without additional approval workflow.

## 6. Command Safety Strategy

## 6.1 Template Engine Rules

1. Templates are static strings with named placeholders.
2. Placeholder values must pass regex and length validation.
3. Disallow metacharacters in interpolated parameters (`;`, `&&`, `|`, backticks, `$(`).
4. Execute command without shell expansion where possible.

## 6.2 Runtime Guards

1. Max command runtime per tool.
2. Max stdout/stderr bytes.
3. Optional per-tool concurrency limits.
4. Retries disabled by default for mutating/sensitive actions.
5. Idempotency keys for any action with side effects.

## 7. Infra Changes (Kubernetes)

Required updates under `deploy/k8s/base`:
1. `networkpolicy.yaml`
- Add egress rule for TCP/22 to approved CIDRs/hosts only.
- Keep deny-all baseline for everything else.

2. `secrets.template.yaml`
- Add `SSH_PRIVATE_KEY`.
- Add `SSH_KNOWN_HOSTS`.
- Add optional `SSH_CONFIG` (if jump hosts required).
- Add per-profile remote endpoints and usernames.

3. `mcp-gateway-deployment.yaml`
- Mount SSH material as read-only volume.
- Add env vars for profile config path and remote command templates.

## 8. Container Build Changes

## 8.1 mcp-gateway image

Install tools:
1. OpenSSH client.
2. `postgresql-client` (`psql`).
3. `supabase` CLI pinned to a known version.

Hardening:
1. Run as non-root user.
2. Read-only filesystem where possible.
3. No package-manager cache retention.

## 9. RBAC and Confirmation Policy

1. Medium/high remote tools restricted to specific roles.
2. High-risk tools require explicit `CONFIRM` token in user prompt.
3. Optional second-factor flow for high-risk tools (future phase):
- Slack interactive button + short-lived approval token.

## 10. Logging and Audit Requirements

For each tool execution, capture:
1. `request_id`
2. `slack_user_id`
3. `resolved_role`
4. `tool_name`
5. `remote_profile`
6. `arguments_hash` (not raw sensitive args)
7. `command_template_id`
8. `exit_code`
9. `duration_ms`
10. `stdout_redacted_preview`
11. `stderr_redacted_preview`
12. `decision` (`allowed`, `denied`, `failed`)

Never log:
1. Private keys.
2. Full raw SQL with sensitive literals.
3. Unredacted PII.

## 11. Test Plan Additions

## 11.1 Unit Tests

1. Command template validation.
2. Parameter sanitization and denylist enforcement.
3. Role and confirmation gating.
4. Redaction of stdout/stderr.

## 11.2 Integration Tests

1. Gateway -> SSH runner with mocked SSH transport.
2. Timeout and output truncation behavior.
3. Unauthorized profile/host access denial.

## 11.3 Staging E2E

1. Low-risk read command success path.
2. High-risk tool rejected without `CONFIRM`.
3. Disallowed role receives denial.
4. Audit log emitted with expected fields.

## 12. Delivery Phases

Phase 0: Design and policy lock (0.5-1 day)
1. Finalize remote host profiles.
2. Finalize initial remote tool set.
3. Approve query/template allowlist.

Phase 1: Core implementation (1-2 days)
1. Add `remote_exec.js` and template/profile loaders.
2. Add tool handlers for initial read-only operations.
3. Add schema + policy enforcement.

Phase 2: Infra and image hardening (1 day)
1. Update Dockerfile with SSH/CLI binaries.
2. Update k8s manifests and secrets template.
3. Verify egress restrictions.

Phase 3: Validation and rollout (1 day)
1. Unit/integration/e2e tests.
2. Staging pilot with limited users.
3. Enable production read-only tools first.

## 13. Acceptance Criteria

1. Only allowlisted remote commands are executable.
2. SSH is restricted to approved host profiles.
3. All executions are auditable with redacted outputs.
4. High-risk tools enforce confirmation + role checks.
5. NetworkPolicy blocks non-approved SSH destinations.
6. Staging tests pass for auth, policy, timeout, and logging behavior.

## 14. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Command injection | critical | strict templates + argument validation + no raw shell eval |
| Credential leakage | critical | secret mounts, never log secrets, rotate keys |
| Over-privileged remote account | high | least privilege account and read-only defaults |
| Host spoofing / MITM | high | strict known_hosts pinning |
| Data overexposure in output | high | redaction + output size limits + role-scoped tools |
| Operational drift in templates | medium | versioned configs + code review approvals |

## 15. Implementation Checklist

1. Add `config/remote-command-templates.json`.
2. Add `config/remote-host-profiles.json`.
3. Implement `services/mcp-gateway/src/remote_exec.js`.
4. Extend `services/mcp-gateway/src/tools.js` for remote tools.
5. Update gateway config to load remote profile/template files.
6. Update Dockerfile with SSH/CLI dependencies.
7. Update k8s secrets and deployment mounts.
8. Update network policies for controlled SSH egress.
9. Add tests for sanitizer, policy, and timeout behaviors.
10. Update runbook with key rotation and incident procedures.

## 16. Full Handoff Context

This section is intended for the next engineer/agent to continue work without re-discovery.

## 16.1 Current Repository State

Repo root for this initiative:
- `/Users/splash/Documents/ABCodex/employee-slackbot`

Current implemented baseline:
1. Slackbot service scaffold exists:
- `services/slackbot/src/index.js`
- `services/slackbot/src/config.js`
- `services/slackbot/src/policy.js`
- `services/slackbot/src/openai_router.js`
- `services/slackbot/src/mcp_client.js`

2. MCP gateway scaffold exists:
- `services/mcp-gateway/src/index.js`
- `services/mcp-gateway/src/config.js`
- `services/mcp-gateway/src/tools.js`
- `services/mcp-gateway/src/logger.js`

3. Allowlist and deployment scaffolding exist:
- `config/allowed-tools.json`
- `deploy/k8s/base/*`
- `deploy/k8s/overlays/{dev,staging,prod}/*`

4. Docs and standards exist:
- `style.md`
- `testing.md`
- `docs/runbook.md`
- `README.md`

5. Existing tests:
- `tests/unit/env-template.test.js`
- `tests/unit/allowed-tools-manifest.test.js`

Known current behavior:
- MCP tool handlers are stubs, not live remote execution.
- Confirmation currently keys off `CONFIRM` text in prompt.
- Gateway has allowlist checks but no SSH layer yet.

## 16.2 Required File Changes (Next Pass)

Planned edits/additions:
1. Add:
- `services/mcp-gateway/src/remote_exec.js`
- `config/remote-command-templates.json`
- `config/remote-host-profiles.json`

2. Modify:
- `services/mcp-gateway/src/config.js`
- `services/mcp-gateway/src/tools.js`
- `services/mcp-gateway/src/index.js`
- `services/mcp-gateway/Dockerfile`
- `deploy/k8s/base/mcp-gateway-deployment.yaml`
- `deploy/k8s/base/networkpolicy.yaml`
- `deploy/k8s/base/secrets.template.yaml`
- `docs/runbook.md`

3. Add tests:
- `tests/unit/remote-command-template.test.js`
- `tests/unit/remote-arg-sanitization.test.js`
- `tests/integration/mcp-remote-exec.test.js`

## 16.3 Expected Environment/Secrets Additions

1. `SSH_PRIVATE_KEY`
2. `SSH_KNOWN_HOSTS`
3. `REMOTE_HOST_PROFILES_FILE`
4. `REMOTE_COMMAND_TEMPLATES_FILE`
5. Optional per-profile vars:
- `REMOTE_BASTION_OPS_HOST`
- `REMOTE_BASTION_FINANCE_HOST`
- `REMOTE_BASTION_PORT`
- `REMOTE_BASTION_USER`

## 16.4 Operational Constraints

1. Do not enable unrestricted shell execution.
2. Do not allow direct SSH egress to all destinations.
3. Do not bypass RBAC/confirmation gates for high-risk tools.
4. Keep mutating tools disabled by default until approval.

## 16.5 Validation Commands

From repo root:

```bash
npm run check
npm test
```

Service-level checks:

```bash
npm --prefix services/mcp-gateway run check
npm --prefix services/slackbot run check
```

K8s dry-check (if kubectl/kustomize available):

```bash
kubectl kustomize deploy/k8s/base
kubectl kustomize deploy/k8s/overlays/dev
```

## 16.6 Definition of Done for This Plan

1. Remote read-only SSH tools work in staging with strict allowlist templates.
2. Security controls (host pinning, RBAC, confirmation, logging) are demonstrably enforced.
3. Tests cover sanitizer, policy gates, timeout behavior, and deny paths.
4. Runbook updated with rotation, incident, and rollback procedures.
