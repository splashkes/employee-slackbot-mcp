# Style Guide (Living Document)

Last Updated: 2026-02-27
Owner: Engineering
Status: Active
Scope: `employee-slackbot` code, tests, and docs

## 1. Purpose

This document defines coding, testing, and Git collaboration conventions for `employee-slackbot`.

## 2. Decision Summary

| Area | Decision |
|---|---|
| Scope | `employee-slackbot` code + tests + docs |
| Formatting/Linting | Auto-format required; lint warnings allowed temporarily |
| JS style specifics | Follow formatter defaults (no manual quote/semicolon overrides) |
| Naming conventions | `snake_case` variables/functions, `PascalCase` classes, `snake_case` files, `UPPER_SNAKE_CASE` env vars |
| Comments/Docstrings | Heavy comments/docstrings throughout |
| PR test requirement | Unit + integration tests required when applicable; docs-only changes exempt |
| Coverage gate | No coverage gate yet |
| Branch model | `main` + short-lived `feature/*` and `fix/*` branches |
| Commit style | Simple imperative sentence (example: `Add Slack signature validator`) |
| Merge strategy | Squash and merge only |
| Direct push to `main` | Allowed |

## 3. Coding Style

### 3.1 Formatting and Linting

1. Use project formatter defaults.
2. Formatting is required before merging.
3. Lint warnings may be temporarily accepted, but they should be resolved in follow-up changes.

### 3.2 Naming Rules

1. Variables/functions: `snake_case`
2. Classes/types: `PascalCase`
3. Files: `snake_case` (example: `slack_signature_validator.js`)
4. Environment variables: `UPPER_SNAKE_CASE`

### 3.3 Comments and Docstrings

1. Use comments/docstrings extensively for readability and maintainability.
2. Public modules/functions should include purpose, inputs, outputs, and key failure behavior.
3. Non-trivial logic should include inline explanatory comments.

## 4. Testing Standard

### 4.1 Required Tests

1. Unit tests for changed logic.
2. Integration tests for behavior that crosses boundaries (Slackbot <-> OpenAI <-> MCP).
3. Docs-only changes are exempt from test requirements.

### 4.2 Coverage

No minimum coverage percentage is enforced at this time.

## 5. Git Workflow

### 5.1 Branching

1. Primary branch: `main`
2. Short-lived branch patterns:
- `feature/<short-description>`
- `fix/<short-description>`

### 5.2 Commits

1. Use imperative commit messages.
2. Keep commits focused and readable.

Examples:
- `Add MCP tool allowlist parser`
- `Fix Slack channel policy check`
- `Update env template for RBAC settings`

### 5.3 Pull Requests and Merge

1. Squash-and-merge only.
2. Direct pushes to `main` are allowed by current team policy.

## 6. Temporary Flex Rules

These are intentional and should be revisited:
1. Lint warnings are temporarily allowed.
2. No coverage gate is currently enforced.
3. Direct pushes to `main` are currently allowed.

## 7. Change Log

| Date | Author | Summary |
|---|---|---|
| 2026-02-27 | Engineering | Initial version from team preference questionnaire |
