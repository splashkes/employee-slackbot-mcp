# Orchestration + Execution Kubernetes Base

This directory is the only Kubernetes deployment structure in this repo.

## Topology

1. Namespace `artbattle-orchestration` for planning, policy, and result synthesis.
2. Namespace `artbattle-execution` for isolated runner pools.

## Apply

```bash
kubectl apply -f deploy/k8s/base/secrets.template.yaml
kubectl apply -k deploy/k8s/base
```

## Notes

1. Replace all placeholders in `secrets.template.yaml` before apply.
2. Runner image references are placeholders.
3. Queue backend is modeled as `redis-streams` in manifests.
4. Capability map is sourced from `execution-capability-catalog.json` in this directory.
