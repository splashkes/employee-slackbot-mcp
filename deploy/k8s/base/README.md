# Orchestration + Execution Kubernetes Base

This directory is the only Kubernetes deployment structure in this repo.

## Topology

1. Namespace `artbattle-orchestration` for planning, policy, and result synthesis.
2. Namespace `artbattle-execution` for isolated runner pools.
3. Namespace `shared` for Redis and other shared infrastructure.

## Apply

```bash
kubectl apply -f deploy/k8s/base/secrets.template.yaml
kubectl apply -k deploy/k8s/base
```

## Before deploying

1. Replace all placeholders in `secrets.template.yaml` with real values.
2. Create a `ghcr-pull` image pull secret in both namespaces (see root README).
3. Build and push container images to `ghcr.io/splashkes/`.
4. In `ingress.yaml`, set `REPLACE_ME_HOSTNAME` to your domain and configure TLS. Omit this file if using Slack Socket Mode.
5. Ensure a Redis instance is running in the `shared` namespace at `redis.shared.svc.cluster.local:6379`.

## Notes

1. Queue backend is modeled as `redis-streams` in manifests.
2. Capability map is sourced from `execution-capability-catalog.json` in this directory.
3. Network policies enforce default-deny with explicit ingress/egress allow rules per plane.
