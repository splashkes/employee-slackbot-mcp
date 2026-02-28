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

### Prerequisites
- A running Kubernetes cluster with an ingress controller (e.g. nginx-ingress).
- `kubectl` configured against the target cluster.
- Container images built and pushed to your registry.

### Steps

1. **Edit secrets** — replace all placeholders in `secrets.template.yaml` with real values.
2. **Set container images** — replace every `REPLACE_ME:latest` in the deployment manifests with your real image references.
3. **Configure ingress** — in `ingress.yaml`, replace `REPLACE_ME_HOSTNAME` with the domain that Slack webhooks will hit. Configure TLS via cert-manager or a pre-provisioned secret. If using Slack Socket Mode, the ingress resource can be removed.
4. **Apply:**

```bash
kubectl apply -f deploy/k8s/base/secrets.template.yaml
kubectl apply -k deploy/k8s/base
```

### External traffic

Slack Events API webhooks and slash commands require a publicly reachable HTTPS endpoint. The `ingress.yaml` resource routes external traffic to the `orchestration-api` service on port 3000. If your cluster uses a different ingress mechanism (ALB, Istio, etc.), adapt accordingly.

If you use **Socket Mode** (`SLACK_USE_SOCKET_MODE=true`), the bot connects outbound to Slack and no ingress is required.

## Validation

```bash
kubectl kustomize deploy/k8s/base
npm run check
npm test
```
