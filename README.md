# Employee Slackbot + MCP Gateway

This repository contains:
1. `services/slackbot` - Slack-facing orchestration service
2. `services/mcp-gateway` - internal tool gateway with role/allowlist checks
3. `config/allowed-tools.json` - tool allowlist policy
4. `deploy/k8s` - Kubernetes base and environment overlays

## Quick Start

### 1) MCP Gateway

```bash
cd services/mcp-gateway
cp .env.example .env
npm install
npm run start
```

### 2) Slackbot

```bash
cd services/slackbot
cp .env.example .env
npm install
npm run start
```

## Root Commands

```bash
npm test
npm run check
```

## Kubernetes

Base manifests:

```bash
kubectl apply -k deploy/k8s/base
```

Dev overlay:

```bash
kubectl apply -k deploy/k8s/overlays/dev
```
