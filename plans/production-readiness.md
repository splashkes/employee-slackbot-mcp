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

- [ ] **1a. Restructure Dockerfiles for workspace support.** Both services need a multi-stage build that:
  1. Copies root `package.json` + `package-lock.json`.
  2. Copies `packages/shared/` (the only workspace dep).
  3. Copies the target service's `package.json`.
  4. Runs `npm install --omit=dev --workspace=services/<name>` from the root.
  5. Copies the service `src/` directory.
  6. Sets `CMD` to `node src/index.js` (avoids needing the service-level `npm run start`).
- [ ] **1b. Update `.dockerignore` files** to allow `packages/` and root `package.json` through when the build context is the repo root.
- [ ] **1c. Verify builds locally.** `docker build -f services/slackbot/Dockerfile .` and `docker build -f services/mcp-gateway/Dockerfile .` should both succeed from the repo root.

---

## 2. Fix OpenAI Model Default (Blocker)

`services/slackbot/src/config.js:44` defaults to `gpt-5-mini`, which is not a real model name.

### Tasks

- [ ] **2a.** Change the default to `gpt-4o-mini` (or whichever model is intended).

---

## 3. Add SIGTERM / Graceful Shutdown Handlers (High)

Neither service handles `SIGTERM`. Kubernetes sends SIGTERM before killing a pod. Without a handler, in-flight Slack responses and gateway tool calls are dropped.

### Tasks

- [ ] **3a. Slackbot (`services/slackbot/src/index.js`):** Listen for `SIGTERM`, call `app.stop()` (Bolt's built-in graceful shutdown), clear the rate-limiter and role-cache sweep intervals, then exit.
- [ ] **3b. MCP gateway (`services/mcp-gateway/src/index.js`):** Listen for `SIGTERM`, call `server.close()`, wait for in-flight requests to drain (with a timeout), then exit.

---

## 4. Implement Real Tool Backends (High)

All 5 tools in `services/mcp-gateway/src/tools.js` (`execute_tool_by_name`) return hardcoded stub data with `"source": "stub"`. The gateway will technically "work" but provide no real value.

### Tasks

- [ ] **4a. Decide on data source connections.** Tools like `get_event_details`, `get_live_voting_status`, `get_auction_status`, `get_payment_summary` need database or API access. Determine which backing service each tool calls (Supabase, Stripe, internal API, etc.).
- [ ] **4b. Implement `get_event_details`** — query Supabase for event record by `eid`.
- [ ] **4c. Implement `get_live_voting_status`** — query Supabase for vote counts.
- [ ] **4d. Implement `get_auction_status`** — query Supabase for auction data.
- [ ] **4e. Implement `get_payment_summary`** — query Supabase for payment records.
- [ ] **4f. Implement `process_artist_payment`** — call Stripe API to initiate payout (behind `enable_mutating_tools` gate).
- [ ] **4g. Add integration tests** for each tool against a test database or mock.

---

## 5. Reconcile K8s Manifests with Actual Services (High)

The k8s manifests define 7 deployments (2 orchestration + 5 execution runners), but only 2 services exist in code (`services/slackbot` = orchestration-api, `services/mcp-gateway`). The 5 execution runner deployments and the `orchestration-supervisor` have no container images to build.

### Tasks

- [ ] **5a. Decide on phased deployment scope.** For the initial launch, only `orchestration-api` (slackbot) and `orchestration-supervisor` or the gateway need to run. The 5 runner deployments are future work.
- [ ] **5b. Option A — Remove runner deployments for now.** Strip the 5 runner deployments, their ServiceAccounts, and their secrets from the manifests. Add them back when runner code exists. Update `kustomization.yaml`, `services.yaml`, and `networkpolicy.yaml` accordingly.
- [ ] **5c. Option B — Keep runners as placeholders.** Set `replicas: 0` on all runner deployments so they exist in the manifest but don't schedule pods. This avoids `ImagePullBackOff` while preserving the target topology.
- [ ] **5d. Map `orchestration-api` image** to the slackbot Docker image. Map `orchestration-supervisor` image to the mcp-gateway Docker image (or create a supervisor service if it's distinct). Update the `REPLACE_ME:latest` references.
- [ ] **5e. Update the `secrets.template.yaml`** to add `MCP_GATEWAY_AUTH_TOKEN` to the orchestration secrets (slackbot needs it to call the gateway).

---

## 6. Health Endpoints — Add Dependency Checks (Medium)

Both `/healthz` and `/readyz` return `200 ok` unconditionally. Kubernetes liveness and readiness probes should reflect actual health.

### Tasks

- [ ] **6a. Slackbot `/readyz`:** Check that the OpenAI API key is set and that a test HEAD request to the MCP gateway `/healthz` succeeds.
- [ ] **6b. MCP gateway `/readyz`:** Check that the tools manifest loaded successfully (it already does — this is a no-op if the manifest is in memory).
- [ ] **6c. Add liveness/readiness probe definitions** to the k8s deployment manifests (`livenessProbe` and `readinessProbe` on each container spec).

---

## 7. Slack App Setup Documentation (Medium)

There's no documentation on how to create the Slack app, configure scopes, install it to a workspace, or obtain the required tokens.

### Tasks

- [ ] **7a. Create `docs/slack-app-setup.md`** covering:
  1. Create a Slack app at api.slack.com/apps.
  2. Required Bot Token Scopes: `app_mentions:read`, `chat:write`, `commands`.
  3. Enable Socket Mode (generate `SLACK_APP_TOKEN` with `connections:write` scope).
  4. Install to workspace and copy `SLACK_BOT_TOKEN`.
  5. Create the `/ab` slash command pointing to the ingress URL (or socket mode).
  6. Subscribe to `app_mention` event.
  7. Copy `SLACK_SIGNING_SECRET` from app settings.
- [ ] **7b. Optionally create a `slack-manifest.yaml`** for one-click Slack app creation via manifest import.

---

## 8. Provision Redis (Medium)

The k8s manifests and secrets reference `redis://redis.shared.svc.cluster.local:6379`, but no Redis deployment exists in the manifests. The code doesn't use Redis yet (queue/event contract is future work), but the architecture references it.

### Tasks

- [ ] **8a. Decide: is Redis needed for v1?** If the slackbot and gateway communicate directly via HTTP (current design), Redis is not needed at launch.
- [ ] **8b. If Redis is not needed for v1:** Remove `REDIS_URL` from `secrets.template.yaml` and note in docs that Redis is deferred to the async agent phase.
- [ ] **8c. If Redis is needed:** Add a Redis `Deployment` + `Service` manifest in `deploy/k8s/base/` under the `shared` namespace. Use `redis:7-alpine` image with appropriate resource limits.

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

- [ ] **10a. If using Socket Mode (recommended for v1):** Set `SLACK_USE_SOCKET_MODE=true` in the orchestration secrets. Remove or skip applying `ingress.yaml`. No domain or TLS needed.
- [ ] **10b. If using Events API:** Provision a domain, point DNS to the DigitalOcean load balancer, install cert-manager or use a DO-managed certificate, and update `REPLACE_ME_HOSTNAME` in `ingress.yaml`.

---

## Execution Order

```
Phase 1 — Build fixes (can deploy after this)
  1. Fix Docker builds                          [Blocker]
  2. Fix OpenAI model default                   [Blocker]
  5. Reconcile k8s manifests with actual code   [High]
  9. Container registry and image push          [Blocker]

Phase 2 — Operational basics
  3. SIGTERM / graceful shutdown                [High]
  6. Health endpoint dependency checks          [Medium]
 10. Ingress / TLS / domain (or Socket Mode)   [Blocker for Events API]

Phase 3 — Connect Slack
  7. Slack app setup documentation             [Medium]
     Fill in real secrets in secrets.template.yaml
     Deploy to cluster
     Verify /ab command and @mention work

Phase 4 — Real tool backends
  4. Implement real tool backends              [High]
  8. Provision Redis (if needed)               [Medium]
```

---

## Out of Scope (tracked separately)

- Execution runner pool code (5 runner services don't exist yet).
- Orchestration supervisor as a distinct service (currently the gateway serves this role).
- Async agent / gatherer pattern and Redis Streams event bus.
- CI/CD pipeline automation.
- Monitoring, alerting, and observability stack.
- Deferred skill IDs (27, 44-49) from the architecture doc.
