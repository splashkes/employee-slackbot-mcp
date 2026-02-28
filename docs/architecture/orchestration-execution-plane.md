# Orchestration + Execution Plane

Date: 2026-02-28  
Status: Canonical  
Source Context: `/Users/splash/vote26-fresh/AB_SKILL_AREAS_REFERENCE.md`

## 1) Goal

Adopt a Kubernetes-first architecture that keeps policy and user interaction centralized in an **orchestration plane**, while moving privileged, tool-heavy, long-running work into an isolated **execution plane**.

This design is optimized for async agents that can gather partial evidence from multiple runners and surface consolidated updates back to orchestration.

## 2) Planes

### Orchestration Plane

Responsibilities:
1. Slack/webhook ingress and identity checks.
2. Role + capability policy evaluation.
3. Workflow planning and task decomposition.
4. Async workflow state machine and user-facing status updates.
5. Result synthesis from execution artifacts.

Services:
1. `orchestration-api` (request intake + sync endpoints).
2. `orchestration-supervisor` (workflow planner/coordinator + artifact aggregation).

### Execution Plane

Responsibilities:
1. Run domain-scoped tools and scripts with least privilege credentials.
2. Emit structured task events and artifacts.
3. Handle long-running/parallel operations and retries.
4. Return outputs in a normalized contract, not free-form logs.

Runner pools (initial):
1. `data-read-runner`
2. `profile-integrity-runner`
3. `payments-runner`
4. `growth-marketing-runner`
5. `platform-db-edge-runner`

## 3) Async Agent Compatibility (Required)

### Event-Driven Contract

All execution tasks must publish lifecycle events:
1. `workflow.created`
2. `task.dispatched`
3. `task.started`
4. `task.heartbeat`
5. `artifact.created`
6. `task.completed`
7. `task.failed`
8. `workflow.completed`

### Artifact Contract

Each task writes a machine-readable artifact with:
1. `workflow_id`
2. `task_id`
3. `skill_id`
4. `runner_domain`
5. `result_summary`
6. `result_payload_ref` (object store pointer)
7. `confidence`
8. `started_at`
9. `finished_at`

### Gatherer Pattern

The orchestration supervisor can spawn one or more gatherer agents that:
1. Subscribe to workflow events.
2. Merge partial outputs from multiple runner domains.
3. Score confidence/conflicts.
4. Surface progressive updates to Slack without waiting for all tasks to finish.

## 4) Capability Coverage (80%+)

Coverage target met now via capability catalog:
1. Total skill areas: 50
2. Covered now: 43
3. Coverage: 86%

Catalog file: `deploy/k8s/base/execution-capability-catalog.json`

### Included Skill IDs by Runner Domain

1. `data-read-runner`: `1,2,3,4,5,17,19,20,22,23,24,25,26,50`
2. `profile-integrity-runner`: `6,7,8,9,10,18,21`
3. `payments-runner`: `11,12,13,14,15,16`
4. `growth-marketing-runner`: `28,29,30,31,32,33,34,35,36,37,38`
5. `platform-db-edge-runner`: `39,40,41,42,43`

### Deferred Skill IDs (rebuild in new system)

1. `27` (QR upgrade flow)
2. `44` (CDN deploy/cache busting)
3. `45` (DigitalOcean app platform management)
4. `46` (Git secret scrubbing/hygiene)
5. `47` (Admin component development)
6. `48` (Promotional offers system)
7. `49` (Sponsorship system)

## 5) Kubernetes Structure

### Namespaces

1. `artbattle-orchestration` (ingress, planner, policy, aggregation).
2. `artbattle-execution` (runner deployments and job workers).
3. `shared` (Redis and other shared infrastructure).

### Ingress

External traffic (Slack webhooks, API clients) enters via an Ingress resource that routes HTTPS to `orchestration-api` on port 3000. Socket Mode is supported as an alternative that requires no inbound ingress.

### Core Deployments

1. `orchestration-api`
2. `orchestration-supervisor`
3. `runner-data-read`
4. `runner-profile-integrity`
5. `runner-payments`
6. `runner-growth-marketing`
7. `runner-platform-db-edge`

### Secret Boundaries

1. Orchestration secrets: Slack tokens, OpenAI key, gateway signing secrets.
2. Execution secrets: domain-specific API keys and DB credentials.
3. No cross-domain secret sharing between runner pools.

### Network Boundaries

1. Default deny-all ingress+egress on both orchestration and execution namespaces.
2. `orchestration-api` allows inbound on port 3000 (external/ingress controller).
3. `orchestration-supervisor` allows inbound on port 8080 (intra-namespace only).
4. Both planes allow egress to Redis in the `shared` namespace on port 6379.
5. Orchestration allows outbound HTTPS (443) and DNS (53).
6. Execution allows outbound HTTPS (443), DNS (53), and Postgres (5432).
7. Execution runners cannot call Slack directly.

## 6) Rollout Order

1. Provision Redis in the `shared` namespace.
2. Replace placeholder secrets and container images in manifests.
3. Configure Ingress hostname and TLS (or enable Socket Mode).
4. Deploy orchestration namespace and services.
5. Deploy execution namespace and runner pools.
6. Enable queue/event contract and artifact aggregation.
7. Activate covered skill domains by policy.
8. Track deferred 7-skill rebuilds as explicit backlog items.
## 7) Acceptance Criteria

1. Orchestration plane remains lightweight and policy-focused.
2. Execution plane handles privileged operations with least privilege.
3. Async agent updates stream partial results reliably.
4. 43/50 skill areas are mappable to runner pools immediately.
5. Deferred 7 skills have explicit rebuild backlog and no hidden dependencies.
