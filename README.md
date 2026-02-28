# Art Battle Orchestration + Execution Platform

This repository uses one canonical architecture:
1. `docs/architecture/orchestration-execution-plane.md` - system design.
2. `deploy/k8s/base` - single Kubernetes topology (no overlays, no versioned alternates).
3. `deploy/k8s/base/execution-capability-catalog.json` - skill coverage map for execution domains.

## Architecture

```bash
cat docs/architecture/orchestration-execution-plane.md
cat deploy/k8s/base/execution-capability-catalog.json
```

## Deploy (Canonical)

```bash
kubectl apply -f deploy/k8s/base/secrets.template.yaml
kubectl apply -k deploy/k8s/base
```

## Validation

```bash
kubectl kustomize deploy/k8s/base
npm run check
npm test
```
