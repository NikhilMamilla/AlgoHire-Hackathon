# CertiFlow: Deployment Plan

> Status: **plan only.** Nothing here is deployed. The repo runs locally with `docker compose up --build`. The sections
> below say which parts already exist in code (**Implemented**) and which are production work still to do
> (**Planned**). Performance numbers are **estimates with the arithmetic shown**, not load-test results. The only
> measurement quoted is a single local PDF render, and it is labelled as such.

## 1. Target load

| Dimension | Number | What it means per second |
|---|---|---|
| Registered users | 100,000 | mostly candidates, who never log in |
| Daily active users | ~10,000 | staff plus verification traffic |
| Peak approvals (results day) | 500 batches / hour | ~0.14 approvals/s, trivial for Postgres |
| Peak PDFs | ~30,000 / hour | **~8.3 PDFs/s** sustained |
| Peak WhatsApp messages | ~30,000 / hour | **~8.3 msgs/s**, bounded by the provider's rate limit |
| Public verification | thousands/day, bursty | design for 200 req/s bursts on one indexed lookup (`certificateNo` is unique) |

The hard part is the **fan-out after approval**: one click becomes about 60 certificates and 60 messages. That work
is asynchronous and queue-backed (`certificates` and `delivery` queues), so the officer's request never waits on it.

## 2. Architecture

```
                         ┌──────────────────────────── AWS ap-south-1 (Mumbai) ───────────────────────────┐
 Staff browser ──HTTPS──▶│ CloudFront ─▶ S3 (static React build)                                          │
 Employer / QR ─HTTPS──▶ │ ALB ─▶ API service (ECS Fargate, N tasks, stateless)                           │
                         │          │  writes ──────────────▶ RDS PostgreSQL (Multi-AZ) ◀── read replica   │
                         │          │  enqueue / publish ───▶ ElastiCache Redis (BullMQ + pub/sub, AOF)     │
                         │          │  SSE fan-out ◀── Redis pub/sub ◀── events from API + workers          │
                         │          ▼                                                                    │
                         │  Worker service (ECS Fargate, autoscaled on queue depth)                       │
                         │    certificates queue: issue certificates in one DB tx (PDF → S3 planned)      │
                         │    delivery queue:     send WhatsApp via BSP (retries with backoff)            │
                         │    maintenance queue:  reconciler (every 30s), SLA escalation (every 30s)      │
                         │                                                                                │
                         │  CloudWatch logs/metrics ─▶ alarms ─▶ SNS ─▶ on-call (email/Slack/PagerDuty)    │
                         └────────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
                               WhatsApp Business API (Meta Cloud API / BSP)
```

Locally the same shape runs as five compose services: `web` (nginx with the static build and the `/api` proxy),
`api`, `worker` (the same image as `api`, entrypoint `src/worker.ts`), `postgres` and `redis` (AOF on).

**Event flow (implemented, as in the code):**
1. The state approval commits in Postgres (`batchWorkflow.ts › decide`), then `onBatchApproved` enqueues
   `issue-certificates` with jobId `issue-<batchId>` (5 attempts, exponential backoff from 2s).
2. `issueCertificates` locks the batch row and, in **one transaction**, creates the certificate rows and delivery rows,
   moves the batch to ISSUED, and writes the audit row.
3. After the commit, one `deliver` job per delivery is enqueued with jobId `deliver-<deliveryId>` (6 attempts,
   exponential backoff from 2s, worker concurrency 5). Each attempt sends, records the status, or rethrows to retry.
4. Every state change is published on Redis channel `certiflow:events`. Each API instance pushes it to its own SSE
   clients, filtered by the same scope rules as the REST API.
5. A revoke is a single DB transaction. Verification always reads the current status from Postgres.

## 3. Hosting choices and why

| Component | Host | Why |
|---|---|---|
| React app | S3 + CloudFront | Static files. Cheap, global, no servers |
| API | ECS Fargate behind ALB | Stateless containers, the same Docker image as local. No cluster to manage (Kubernetes is overkill for 2 services) |
| Workers | ECS Fargate, separate service | Scales independently from the API on queue depth. A crash never affects user requests |
| PostgreSQL | RDS Multi-AZ | Source of truth. Managed backups, PITR, automatic failover |
| Redis | ElastiCache (primary + replica, AOF) | BullMQ needs Redis. Managed failover |
| PDFs | S3 private bucket, SSE-KMS | Durable and cheap. Served only through short-lived signed URLs |
| Region | ap-south-1 Mumbai | Users are in India. Data residency |

All of §3 is **Planned**. Today everything runs in Docker Compose.

## 4. Scaling

**What scales horizontally:**
- **API tasks:** stateless. JWT auth means no session affinity, and SSE fan-out goes through Redis pub/sub, so any
  instance can serve any client. Autoscale on CPU or request count. (**Implemented:** the stateless design and Redis
  fan-out. **Not yet tested** with more than one instance.)
- **Workers:** autoscale on the BullMQ waiting-job count (published as a CloudWatch metric). Queues deliver at least
  once, and every processor is idempotent at the DB level, so adding or killing workers is safe. (**Implemented:**
  idempotent processors, unique constraints, delivery concurrency 5 per worker.)
- **Verification reads:** route them to a read replica. **Planned:** a Redis cache in front, with explicit
  invalidation on revoke (see §6).

**What limits throughput at peak, in order:**
1. **The WhatsApp provider rate limit.** Meta's Cloud API starts around 80 msgs/s per number. Our ~8 msgs/s is well
   inside that. **Planned:** set BullMQ's `limiter` on the `delivery` worker to the provider's tier so retries can't
   make a throttle storm worse. (Not in the code today.)
2. **PDF rendering CPU.** One local render of the current certificate (with the full-page background) took about
   60 ms (a single sample on a laptop, not a benchmark). At ~10–20 PDFs/s per vCPU (estimate), 30,000 PDFs need about
   0.5–1 vCPU-hour, so 4 workers × 1 vCPU clear the backlog in roughly 10–15 minutes. Today PDFs render on download,
   so this cost lands on the API. Pre-rendering (§6) moves it into the throttled queue.
3. **Postgres writes:** 30,000 certificate inserts per hour arrive as one `createMany` transaction per batch. That's
   ~500 transactions per hour, well within a db.t4g.medium.

**Clearing the backlog:** jobs wait durably in Redis. Autoscaling adds workers when waiting jobs exceed a threshold,
for example 1,000. Ordering comes from the design, not from queue priorities. Delivery jobs are only enqueued after
the issuance transaction commits, so certificates are verifiable before any message goes out. Delivery has its own
queue, so a WhatsApp slowdown never delays issuance.

## 5. Failure handling

| Failure | What happens | Implemented? |
|---|---|---|
| **Worker crash mid-job** | BullMQ detects the stalled job (lock expiry) and gives it to another worker. Issuance runs in one DB transaction with `SELECT … FOR UPDATE` on the batch, so a half-finished attempt rolls back and the retry sees either nothing or a fully ISSUED batch (an ISSUED batch is a no-op). Unique `candidateId` on Certificate and unique `certificateId` on Delivery make duplicates impossible even if two attempts overlap. | **Yes** (tested: sequential and 3× concurrent issuance) |
| **Crash between DB commit and enqueue** | The reconciler (`jobs/reconcile.ts`, every 30s) re-enqueues APPROVED batches whose `stageEnteredAt` is more than 30s old and PENDING deliveries not updated for 2+ minutes. That's safe because processors are idempotent. Enqueue failures after a commit are logged, never thrown to the user. | **Yes** (reconciler has no automated test yet) |
| **Redis restart** | Redis runs with AOF persistence (`--appendonly yes`, named volume), so queued jobs survive. If Redis data is lost entirely, Postgres is still the source of truth and the reconciler rebuilds the work from DB state. The public rate limiter fails open (logged), a deliberate choice for verification availability. SSE clients reconnect automatically. | **Yes** (AOF + reconciler + fail-open); managed failover **Planned** |
| **WhatsApp outage** | Certificates are already issued and verifiable. Delivery jobs retry with exponential backoff (6 attempts, starting at 2s), then the delivery is marked FAILED. The state office can "Retry failed deliveries" (`POST /api/deliveries/retry-failed`) once the provider recovers. Provider calls carry `idempotencyKey = delivery id` and a 3s timeout, so a timeout after the provider accepted can't produce a second message. Candidates can still get the PDF via the owning centre or the state office. | **Yes** (with the simulated provider; `WHATSAPP_MODE=down` demonstrates it) |
| **Slow database** | Approvals keep short transactions (one row lock, few writes). Queue processing slows down but doesn't drop work. The readiness probe times out each dependency check after 2s instead of hanging. Planned: statement timeouts, a PgBouncer/RDS Proxy connection cap, verification reads on a replica, and an alert on p95 latency. | **Partly** |
| **API instance dies** | The ALB health check (`/api/health/ready`, which checks Postgres and Redis) removes it, and SSE clients reconnect to another instance. | Health endpoints **Yes**; ALB **Planned** |

## 6. Certificate storage and access control

- **Today (implemented):** PDFs are rendered on demand from DB data (`certificates/pdf.ts`, A4 landscape on the
  designed background, QR code to `/verify/<certNo>`), so a revoked certificate can never be served (410). Access is
  allowed only via (a) the candidate's HMAC-SHA256-signed download link sent on WhatsApp (`DOWNLOAD_TOKEN_SECRET`),
  or (b) a logged-in state office user or the owning centre. Anything else gets 403. Today the links don't expire;
  an expiry timestamp in the HMAC is planned.
- **Production (planned):** pre-render each PDF at issuance into a private S3 bucket (`certificates/{certNo}.pdf`,
  SSE-KMS, no public ACL). The download endpoint checks the same rules and status = VALID, then returns a 5-minute
  pre-signed URL. Revocation tags the object, and a lifecycle rule can move it to a restricted prefix. Each PDF is
  about 140 KB (measured on a sample render): the background is a 128 KB JPEG embedded as-is (DCTDecode, no
  re-encoding), plus the text and QR code.
- **Public verification:** returns only status, name, course, centre and dates (an allow-listed key set, tested). No
  phone, candidateRef, internal ids or PDF. Certificate numbers are `CF-` + 10 Crockford base32 characters (50 random
  bits), so they can't be enumerated, and `/api/public/*` is rate-limited per IP in Redis (`PUBLIC_RATE_LIMIT`, default
  60/min). **Planned:** cache-aside in Redis keyed by certNo with a 5-minute TTL, where revoke deletes the key in the
  same request after commit, so a revoked certificate still shows REVOKED on the very next lookup. A CDN cache is
  deliberately not used for status, because it would delay revocation.
- **Staff access (implemented):** role and scope checks on every API route (centre: own centre, officer: own district,
  quality: batches in quality review or decided by them, state: everything). An out-of-scope batch is 404. Staff see
  candidate phones masked except the owning centre. **Planned:** replace demo sign-in with real auth (OIDC, e.g. state
  SSO), short-lived JWTs and MFA for state office users.
- **Audit log (implemented):** append-only, enforced by a Postgres trigger that rejects UPDATE and DELETE, and written
  in the same transaction as each change. **Planned:** nightly export to S3 with Object Lock (WORM).

## 7. Monitoring and alerting

- **Logs (implemented):** structured JSON (pino) with an `x-request-id` per request. The API and worker log a warning
  at startup if `JWT_SECRET` or `DOWNLOAD_TOKEN_SECRET` are still the dev defaults. Every batch and certificate can be
  traced end to end through the AuditLog table (actor, action, entity, metadata, time), which the UI shows as a
  timeline. Shipping the logs to CloudWatch is **Planned**.
- **Metrics (planned):**
  - queue waiting and active counts and failed jobs per queue
  - delivery success rate and attempts
  - issuance latency (approved to ISSUED)
  - verification request rate and 429s
  - API p95 latency and 5xx rate
  - DB CPU and connections

  Today `GET /api/stats` (state only) gives live counts of batches by status, certificates and deliveries.
- **Alerts (planned, SNS to on-call):**
  - delivery failure rate > 20% for 10 min (likely WhatsApp outage)
  - waiting jobs > 5,000 or oldest job > 15 min
  - any batch APPROVED but not ISSUED after 10 min
  - API 5xx > 1%
  - DB CPU > 80% for 10 min
  - Redis memory > 75%
- **Business SLA (implemented):** batches that wait longer than `SLA_MINUTES` (default 2, a demo value) in a review
  stage are escalated once by the maintenance job (`jobs/escalate.ts`, every 30s). Escalations are shown in the state
  dashboard and the audit log.

## 8. Approximate monthly cost (AWS ap-south-1, on-demand; rough)

| Item | Sizing | ~USD/month |
|---|---|---|
| ECS Fargate, API | 2 tasks × 0.5 vCPU/1 GB, scales to 6 at peak | 40–70 |
| ECS Fargate, workers | 2 tasks × 1 vCPU/2 GB, scales to 8 on results day | 60–100 |
| RDS PostgreSQL | db.t4g.medium Multi-AZ, 100 GB gp3 | 150 |
| Read replica (optional at launch) | db.t4g.medium | 60 |
| ElastiCache Redis | cache.t4g.small primary + replica | 50 |
| ALB | 1 | 25 |
| S3 + CloudFront | ~100k PDFs/year at ~140 KB each (~14 GB/year), plus the static site | 5–10 |
| NAT gateway + data transfer | 1 NAT | 40 |
| CloudWatch logs/metrics/alarms | | 30 |
| **Infra total** | | **~$460–535** |
| WhatsApp messages | ~8,000–30,000/month (utility template, India) | roughly $15–60, depending on the BSP |

These are list-price estimates, not quotes.

**Trade-offs:**
- **Fargate over EKS:** less to operate, slightly higher cost per vCPU.
- **Multi-AZ RDS:** doubles the DB cost, but the database holds the legal record.
- **Redis/BullMQ as the queue instead of Kafka or SQS:** one fewer system (Redis is already needed for pub/sub and
  rate limiting). BullMQ gives retries, backoff, stalled-job recovery, repeatable jobs and rate limits out of the box,
  and our volume is small. The cost is that Redis must be persistent and highly available, which is why we keep AOF,
  run a replica and use Postgres-driven reconciliation.
- **On-demand PDF rendering (current) vs pre-rendered S3 files (planned):** on demand has no storage and no stale files,
  but the peak download burst after WhatsApp delivery is CPU-heavy. Pre-rendering moves
  that cost into the queue, where it can be throttled.
- **Cost-saving levers:** Fargate Spot for workers (they're interruption-safe because jobs are idempotent), and
  scaling workers to 1 outside results days.

## 9. Implementation status at a glance

| Area | Implemented? | Where |
|---|---|---|
| Containers (api + worker image, web image) | **Yes** | `apps/api/Dockerfile`, `apps/web/Dockerfile`; built in CI |
| Health checks for all 5 services | **Yes** | `/api/health`, `/api/health/ready`; compose healthchecks (worker via a heartbeat file) |
| Idempotent jobs, retries, reconciler, SLA job | **Yes** | `src/jobs/*`, `src/queues.ts`, `src/worker.ts` |
| Redis AOF persistence | **Yes** (compose) | `docker-compose.yml` |
| Live updates across instances (Redis pub/sub + SSE) | **Yes** (single instance verified) | `src/realtime.ts` |
| Rate limiting on public routes | **Yes** (fails open) | `src/rateLimit.ts` |
| Structured logs + request ids | **Yes** | `src/app.ts` (pino-http) |
| CI: tests, walkthrough, web build, docker build | **Yes** | `.github/workflows/ci.yml` |
| Migrations on start | **Partly** | `prisma migrate deploy` in the api command; should become a release job with N instances |
| Real auth (SSO/OTP, MFA) | **No** | demo sign-in today |
| Secret manager, TLS, WAF | **No** | |
| Pre-rendered PDFs in S3, signed URLs | **No** | rendered on demand |
| Verification cache | **No** | always reads Postgres |
| Metrics, alerts, dashboards | **No** | `/api/stats` only |
| Backups / PITR | **No** | managed-service feature |
| CD and E2E in CI | **No** | `npm run e2e -w apps/web` runs locally against compose |

## 10. Release steps (when built)

1. Build and push the images, tagged with the commit SHA.
2. Run `prisma migrate deploy` as a one-off job against the production database.
3. Roll out the API and worker images. Workers drain on SIGTERM (`worker.close()`); the API stops accepting
   connections and then exits.
4. Smoke test: `/api/health/ready`, a verify lookup, and `scripts/walkthrough.sh <staging-url>`.
5. Roll back by redeploying the previous image tag. Migrations are additive (expand → contract) so the old code still runs.
