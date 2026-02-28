# Production Readiness Plan

Date: 2026-02-28
Target: Deploy to DigitalOcean Kubernetes, connect Slack

## Status Legend

- [ ] Not started
- [x] Done

---

## 1. Fix Docker Builds (Blocker)

Both Dockerfiles copy only their own `package.json` and run `npm install` from the service directory. Since the `@abcodex/shared` workspace dependency is resolved via the root `workspaces` field, `npm install` inside a container that has no root `package.json` or `packages/shared/` will fail.

### Tasks

- [x] **1a. Restructure Dockerfiles for workspace support.** Both services need a multi-stage build that:
  1. Copies root `package.json` + `package-lock.json`.
  2. Copies `packages/shared/` (the only workspace dep).
  3. Copies the target service's `package.json`.
  4. Runs `npm ci --omit=dev --workspace=services/<name>` from the root.
  5. Copies the service `src/` directory.
  6. Sets `CMD` to `node src/index.js` (avoids needing the service-level `npm run start`).
- [x] **1b. Update `.dockerignore` files** — moved to repo root for repo-root build context. Old per-service files removed.
- [ ] **1c. Verify builds locally.** `docker build -f services/slackbot/Dockerfile .` and `docker build -f services/mcp-gateway/Dockerfile .` should both succeed from the repo root.

---

## 2. Fix OpenAI Model Default (Blocker)

`services/slackbot/src/config.js:44` defaults to `gpt-5-mini`, which is not a real model name.

### Tasks

- [x] **2a.** Changed default to `gpt-4o-mini`.

---

## 3. Add SIGTERM / Graceful Shutdown Handlers (High)

Neither service handles `SIGTERM`. Kubernetes sends SIGTERM before killing a pod. Without a handler, in-flight Slack responses and gateway tool calls are dropped.

### Tasks

- [x] **3a. Slackbot (`services/slackbot/src/index.js`):** Listens for `SIGTERM`/`SIGINT`, calls `app.stop()`, clears role-cache sweep interval, then exits.
- [x] **3b. MCP gateway (`services/mcp-gateway/src/index.js`):** Listens for `SIGTERM`/`SIGINT`, calls `server.close()`, waits for in-flight requests to drain (10s timeout), then exits.

---

## 4. Implement Real Tool Backends (High) — ✅ DONE

Original 5 stubs replaced with 46 real tools across 5 domain modules, all backed by direct Supabase Postgres SQL.

### Tasks

- [x] **4a. Data source: Supabase Postgres via `postgres` npm package.** Edge Functions for mutations.
- [x] **4b-f. 46 tools implemented** across 5 domain modules:
  - `src/tools/data_read.js` — 15 read-only SQL tools
  - `src/tools/profile_integrity.js` — 10 tools (4 write-gated)
  - `src/tools/payments.js` — 9 tools (2 write-gated)
  - `src/tools/growth_marketing.js` — 7 read-only tools
  - `src/tools/platform_ops.js` — 5 read-only tools
- [x] **4g. Smart skill selection** — AI system prompt acts as skill selector, employees don't need tool names.
- [x] **4h. Observability** — `esbmcp_` tables for chat sessions, tool executions, audit log, errors, feedback.
- [ ] **4i. Integration tests** against real DB (deferred to first deploy).

---

## 5. Reconcile K8s Manifests with Actual Services (High)

The k8s manifests define 7 deployments (2 orchestration + 5 execution runners), but only 2 services exist in code (`services/slackbot` = orchestration-api, `services/mcp-gateway`). The 5 execution runner deployments and the `orchestration-supervisor` have no container images to build.

### Tasks

- [x] **5a. Decide on phased deployment scope.** Only `orchestration-api` (slackbot) and `orchestration-supervisor` (mcp-gateway) run for v1. Runners are deferred.
- [x] **5b. Keep runners as placeholders.** Set `replicas: 0` on all 5 runner deployments so they exist in the manifest but don't schedule pods. Avoids `ImagePullBackOff` while preserving target topology.
- [x] **5c. Map `orchestration-api` image** to slackbot Docker image. Map `orchestration-supervisor` to mcp-gateway. Image refs already use `ghcr.io/splashkes/`.
- [x] **5d. Fix orchestration-supervisor port** from 8080 to 8081 to match MCP gateway default. Updated deployment, service, and network policy.
- [x] **5e. Update `secrets.template.yaml`** — added `MCP_GATEWAY_AUTH_TOKEN` to orchestration secrets. Removed `REDIS_URL` (not needed for v1).
- [x] **5f. Add env vars to orchestration-api deployment** — `SLACK_USE_SOCKET_MODE=true`, `MCP_GATEWAY_URL` pointing to supervisor service, `ALLOWED_TOOLS_FILE` path. Removed unused capability-catalog volume mount.
- [x] **5g. Remove orchestration-supervisor env vars** for `TASK_QUEUE_BACKEND` and `EVENT_TOPICS` (not used in v1 — gateway is HTTP-only).
- [x] **5h. Remove ingress.yaml from kustomization.yaml** (not needed with Socket Mode). File kept for future Events API mode.
- [x] **5i. Remove configMapGenerator** for execution-capability-catalog (config baked into Docker images).

---

## 6. Health Endpoints — Add Dependency Checks (Medium)

Both `/healthz` and `/readyz` return `200 ok` unconditionally. Kubernetes liveness and readiness probes should reflect actual health.

### Tasks

- [x] **6a. Slackbot `/readyz`:** Checks that OpenAI API key is set and HEAD request to MCP gateway `/healthz` succeeds (3s timeout).
- [x] **6b. MCP gateway `/readyz`:** Already functional — returns 200 when tools manifest is loaded.
- [x] **6c. Liveness/readiness probes** already defined in k8s deployment manifests.

---

## 7. Slack App Setup Documentation (Medium)

There's no documentation on how to create the Slack app, configure scopes, install it to a workspace, or obtain the required tokens.

### Tasks

- [x] **7a. Created `docs/slack-app-setup.md`** covering app creation, scopes, Socket Mode, installation, slash command, event subscriptions, and signing secret.
- [ ] **7b. Optionally create a `slack-manifest.yaml`** for one-click Slack app creation via manifest import.

---

## 8. Provision Redis (Medium)

The k8s manifests and secrets reference `redis://redis.shared.svc.cluster.local:6379`, but no Redis deployment exists in the manifests. The code doesn't use Redis yet (queue/event contract is future work), but the architecture references it.

### Tasks

- [x] **8a. Redis is NOT needed for v1.** Slackbot and gateway communicate directly via HTTP.
- [x] **8b. Removed `REDIS_URL` from orchestration-secrets.** Kept in runner secrets for future use. Redis is deferred to the async agent phase.

---

## 9. Container Registry and Image Push (Blocker)

Using GitHub Container Registry (ghcr.io) since the repo is on GitHub. Image refs are already set in the k8s manifests (`ghcr.io/splashkes/<name>:latest`).

### Tasks

- [x] **9a. Image refs set in manifests** — all deployments point to `ghcr.io/splashkes/`.
- [x] **9b. `imagePullSecrets` added** — all deployment specs reference a `ghcr-pull` secret.
- [ ] **9c. Create the `ghcr-pull` secret in both namespaces:**
  ```
  for NS in artbattle-orchestration artbattle-execution; do
    kubectl create secret docker-registry ghcr-pull \
      --docker-server=ghcr.io \
      --docker-username=splashkes \
      --docker-password=<GITHUB_PAT_WITH_READ_PACKAGES> \
      -n $NS
  done
  ```
- [ ] **9d. Build and push images** (after Dockerfiles are fixed in item 1):
  ```
  docker build -f services/slackbot/Dockerfile -t ghcr.io/splashkes/orchestration-api:v1 .
  docker build -f services/mcp-gateway/Dockerfile -t ghcr.io/splashkes/orchestration-supervisor:v1 .
  docker push ghcr.io/splashkes/orchestration-api:v1
  docker push ghcr.io/splashkes/orchestration-supervisor:v1
  ```
- [ ] **9e. Optional: add a GitHub Actions workflow** to build and push on merge to main.

---

## 10. Ingress, TLS, and Domain (Blocker for Events API mode)

`deploy/k8s/base/ingress.yaml` has `REPLACE_ME_HOSTNAME`. If using Events API (not Socket Mode), Slack needs a publicly reachable HTTPS endpoint.

### Tasks

- [x] **10a. Using Socket Mode for v1.** `SLACK_USE_SOCKET_MODE=true` set in orchestration-api deployment env. Ingress removed from kustomization.yaml. No domain or TLS needed.
- [ ] **10b. If using Events API (future):** Provision a domain, point DNS to the DigitalOcean load balancer, install cert-manager or use a DO-managed certificate, and update `REPLACE_ME_HOSTNAME` in `ingress.yaml`.

---

## Execution Order

```
Phase 1 — Build fixes (can deploy after this)            ✅ DONE
  1. Fix Docker builds                          [Blocker]  ✅
  2. Fix OpenAI model default                   [Blocker]  ✅
  5. Reconcile k8s manifests with actual code   [High]     ✅
  9. Container registry and image push          [Blocker]  ⚠️  9c/9d/9e remain (manual ops)

Phase 2 — Operational basics                              ✅ DONE
  3. SIGTERM / graceful shutdown                [High]     ✅
  6. Health endpoint dependency checks          [Medium]   ✅
 10. Ingress / TLS / domain (or Socket Mode)   [Blocker]  ✅ (Socket Mode chosen)

Phase 3 — Connect Slack                                   ⚠️ MANUAL
  7. Slack app setup documentation             [Medium]   ✅
     Fill in real secrets in secrets.template.yaml         ⬜ (manual)
     Deploy to cluster                                     ⬜ (manual)
     Verify /ab command and @mention work                  ⬜ (manual)

Phase 4 — Real tool backends                              ✅ DONE
  4. Implement real tool backends              [High]     ✅ (46 tools)
  8. Provision Redis (if needed)               [Medium]   ✅ (deferred — not needed for v1)

Phase 5 — Observability (run SQL on Supabase)              ⚠️ MANUAL
     Run sql/001_create_esbmcp_tables.sql                  ✅ (completed 2026-02-28)
     Run sql/002_create_esbmcp_views.sql                   ✅ (completed 2026-02-28)
```

---

## Post-Launch Improvements (completed 2026-02-28)

All deployed to DigitalOcean DOKS (`esbmcp` cluster, `artbattle-orchestration` namespace):

- [x] Slack mrkdwn formatting (system prompt + post-processor)
- [x] Multi-round tool chaining (up to 5 OpenAI API rounds)
- [x] Typing indicator (hourglass reaction)
- [x] Open viewer channels (any user gets read-only in specified channels)
- [x] Interactive confirm/cancel buttons for non-low-risk tools
- [x] Bot self-introspection tools (errors, sessions, tool stats)
- [x] Token usage tracking and estimated cost per session
- [x] Timezone awareness (UTC → event's local timezone)
- [x] Thread-aware replies (bot threads under user's message)
- [x] Thread context (follow-up @mentions in thread carry conversation history)
- [x] UUID validation (prevents SQL crashes from hallucinated IDs)
- [x] Bug report filing via the bot
- [x] Payment balance using production formula (dynamic artist_auction_portion)
- [x] Switched from ghcr.io to DigitalOcean Container Registry

## Out of Scope (tracked separately)

- Execution runner pool code (5 runner services reserved for async agents).
- Async agent / gatherer pattern and Redis Streams event bus.
- CI/CD pipeline automation (currently manual docker build/push/rollout).
- Event creation tool (needs admin SPA validation matching).
- Integration tests against real Supabase database.
- GitHub Actions workflow for automated builds.
