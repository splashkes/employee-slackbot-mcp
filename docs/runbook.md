# Orchestration + Execution Runbook

Last Updated: 2026-02-28
Owner: Platform Engineering

## 1. Services

### Orchestration Plane

1. `orchestration-api` (port `3000`)
2. `orchestration-supervisor` (port `8080`)

### Execution Plane

1. `runner-data-read`
2. `runner-profile-integrity`
3. `runner-payments`
4. `runner-growth-marketing`
5. `runner-platform-db-edge`

## 2. Health Checks

### Orchestration API

```bash
curl -sS http://localhost:3000/healthz
curl -sS http://localhost:3000/readyz
```

### Orchestration Supervisor

```bash
curl -sS http://localhost:8080/healthz
curl -sS http://localhost:8080/readyz
```

## 3. Deployment

```bash
kubectl apply -f deploy/k8s/base/secrets.template.yaml
kubectl apply -k deploy/k8s/base
```

## 4. Common Incidents

### 4.1 Task backlog growth

Checks:
1. Verify queue connectivity from orchestration and runner pods.
2. Verify runner deployments are healthy and not CPU throttled.
3. Check task concurrency env values per runner domain.

### 4.2 Domain task failures

Checks:
1. Confirm domain-specific secrets exist in `artbattle-execution` namespace.
2. Validate egress access for required external APIs/DB endpoints.
3. Verify skill-to-domain mapping in `execution-capability-catalog.json`.

### 4.3 Missing workflow updates in orchestration

Checks:
1. Confirm `task.*` and `artifact.*` events are emitted by runners.
2. Confirm aggregation service can read event stream and artifact store.

## 5. Secret Rotation

1. Rotate orchestration secrets in `artbattle-orchestration` namespace.
2. Rotate runner-domain secrets in `artbattle-execution` namespace.
3. Restart impacted deployments and verify workflow execution.

## 6. Emergency Read-Only Mode

1. Disable mutating capabilities in orchestration policy.
2. Scale down mutating runner pools (`runner-payments`, `runner-profile-integrity`).
3. Keep `runner-data-read` active for diagnostics and status visibility.
