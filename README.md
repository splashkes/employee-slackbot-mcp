# Art Battle Employee Slackbot

An internal Slack assistant that lets Art Battle employees query operational data in natural language. Employees describe their problem — the AI selects the right tools automatically.

## Architecture

- **Slackbot** (`services/slackbot/`) — Slack ingress, OpenAI routing, session logging
- **MCP Gateway** (`services/mcp-gateway/`) — 46 tools across 5 domains, direct Supabase SQL
- **Observability** — `esbmcp_` tables for sessions, tool executions, audit, errors, feedback

```bash
cat docs/architecture/orchestration-execution-plane.md   # canonical architecture
cat docs/runbook.md                                       # operations guide
```

## Tool Coverage

46 tools covering 80% of 50 operational skill areas:

| Domain | Tools | Examples |
|--------|-------|---------|
| data-read | 15 | Event lookup, vote data, auction revenue, Eventbrite |
| profile-integrity | 10 | Duplicate detection, artist updates, invitations |
| payments | 9 | Stripe status, payment ledger, artists owed |
| growth-marketing | 7 | Meta ads, SMS campaigns, offers, sponsorships |
| platform-ops | 5 | Email/Slack queue health, RLS policies, live diagnostics |

## Deploy

### Prerequisites
- Kubernetes cluster with `kubectl` configured
- Container images pushed to `ghcr.io/splashkes/`
- Supabase Postgres connection string

### Steps

```bash
# 1. Run observability migrations on Supabase (one-time)
psql "$SUPABASE_DB_URL" -f sql/001_create_esbmcp_tables.sql
psql "$SUPABASE_DB_URL" -f sql/002_create_esbmcp_views.sql

# 2. Edit secrets
vi deploy/k8s/base/secrets.template.yaml

# 3. Create image pull secret
for NS in artbattle-orchestration artbattle-execution; do
  kubectl create secret docker-registry ghcr-pull \
    --docker-server=ghcr.io \
    --docker-username=splashkes \
    --docker-password=<GITHUB_PAT> \
    -n $NS
done

# 4. Apply
kubectl apply -f deploy/k8s/base/secrets.template.yaml
kubectl apply -k deploy/k8s/base
```

## Development

```bash
npm install
npm run dev:slackbot        # start slackbot with --watch
npm run dev:mcp-gateway     # start gateway with --watch
npm run check               # syntax check all files
npm test                    # run test suite
```

## Validation

```bash
kubectl kustomize deploy/k8s/base
npm run check
npm test
```
