# Deployment plan

CertiFlow currently runs only on a laptop with Docker Compose. **Nothing is deployed.** This is the plan for running it
in production, with an honest "Implemented?" column: **Yes** means the code or config is in this repo and verified,
**Partly** means a building block exists, and **No** means planned only.

## Target shape

```
Internet ─► CDN / WAF ─► Load balancer (TLS) ─► web (nginx, static SPA) ─┐
                                              └► api × N (stateless) ───┼─► Managed PostgreSQL (primary + replica, PITR)
                                                                         ├─► Managed Redis (AOF / replicated)
                                              worker × M (BullMQ) ───────┘─► WhatsApp Business API (BSP)
                                                                           └─► Object storage (signed PDF URLs)
```

The API holds no session state (JWT + DB lookup), and live updates fan out through Redis pub/sub, so API instances
can be added behind a load balancer without sticky sessions. SSE needs the proxy to keep idle connections open;
heartbeats are sent every 20s.

## Checklist

| Area | What production needs | Implemented? | Notes |
|---|---|---|---|
| Containers | One API image (api + worker entrypoints), one web image | **Yes** | `apps/api/Dockerfile`, `apps/web/Dockerfile`; built in CI (`docker compose build`) |
| Health checks | Liveness / readiness for the orchestrator | **Yes** | `/api/health`, `/api/health/ready` (Postgres + Redis); compose healthchecks for all 5 services, worker via heartbeat file |
| Database migrations | Run once per release, before new code | **Partly** | `prisma migrate deploy` runs on API start (fine for one instance). With N instances it should be a separate release job |
| Seed data | Real users and centres from an admin process | **No** | The seed creates demo users only |
| Authentication | SSO / OTP login, short-lived tokens, refresh, logout | **No** | Demo sign-in. Authorization (roles + scope) is fully server-side and would stay as is |
| Secrets | From a secret manager, rotated | **No** | Env vars with dev defaults; API and worker **log a warning** when defaults are in use |
| TLS | HTTPS everywhere, HSTS | **No** | Terminate at the load balancer |
| Horizontal scale (API) | Stateless instances, shared event bus | **Partly** | Designed for it (JWT + Redis pub/sub SSE fan-out); never run with more than one instance or load-tested |
| Workers | Scale out; retries; idempotency | **Yes** | BullMQ, delivery concurrency 5, exponential backoff, idempotent processors, reconciler every 30s |
| Redis durability | Queued jobs survive restarts | **Partly** | AOF on in compose; production needs managed/replicated Redis |
| Postgres durability | Backups, PITR, replica | **No** | Use the managed service's features |
| PDF storage | Generate once, store, serve signed URLs | **No** | Rendered on demand per download; fine for the demo, wasteful at scale |
| WhatsApp | Real BSP integration, templates, delivery webhooks | **No** | `WhatsAppProvider` interface + simulated provider; a real provider would implement `send()` with the same idempotency key |
| Verification load | Cache or read replica for public verify | **No** | Always reads Postgres (needed for instant revocation). A cache must be invalidated on revoke |
| Rate limiting | At the edge + in the app | **Partly** | App-level Redis limiter on `/api/public/*` (60/min/IP, fails open). Add WAF / edge limits |
| Client IP | Trust exactly the proxies in front | **Partly** | `trust proxy = 1` (nginx); the API port is not published. Adjust the hop count behind a load balancer |
| Logging | Structured logs, request ids | **Yes** | pino JSON logs with `x-request-id` |
| Metrics, tracing, alerts | Queue depth, failed deliveries, SLA breaches, error rate | **No** | `/api/stats` gives counts; no metrics exporter |
| CI | Tests on every push | **Yes** | GitHub Actions: API tests against Postgres + Redis, curl walkthrough, web build, Docker build |
| CD | Automatic deploys, rollback | **No** | |
| E2E in CI | Browser tests on a full stack | **No** | `npm run e2e -w apps/web` runs locally against compose |
| Data protection | Minimise PII, retention policy | **Partly** | Phones masked for staff and in the outbox; public verify returns no phone/ref. No retention policy yet |

## Release steps (when built)

1. Build and push the images (tagged with the commit SHA).
2. Run `prisma migrate deploy` as a one-off job against the production database.
3. Roll out the API and worker images. Workers drain on SIGTERM (`worker.close()`); the API stops accepting connections and then exits.
4. Smoke test: `/api/health/ready`, a verify lookup, and `scripts/walkthrough.sh` against staging.
5. Roll back by redeploying the previous image tag. Migrations are additive (expand → contract) so the old code still runs.
