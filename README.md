# CertiFlow

Skilling certificate issuance for a state skills mission. A training centre uploads its candidates, district, quality
and state reviewers approve the batch, the system issues certificates and sends each candidate a WhatsApp message.
Anyone, such as an employer, can verify a certificate from its QR code. Revocation takes effect on the next check.

![Public verification](apps/web/e2e/screenshots/06-verify-valid.png)

**Run it:** `docker compose up --build -d`, then open http://localhost:8080. See [SETUP.md](SETUP.md).
Deployment plan: [DEPLOYMENT.md](DEPLOYMENT.md). Self-review: [docs/SELF_REVIEW.md](docs/SELF_REVIEW.md).

---

## 1. Requirements note

How the brief was interpreted. Where the brief left a choice open, the choice and its reason are stated.

- **Roles and scope.** Four roles. `CENTRE` sees only its own centre's batches. `DISTRICT_OFFICER` sees its district.
  `QUALITY` sees batches currently in quality review plus any it decided on. `STATE` sees everything. A batch you may
  not see returns **404, not 403**, so its existence isn't leaked. One function (`scope.ts › batchScope`) defines this
  for every list, detail, action and live event.
- **Approval chain.** `DRAFT → DISTRICT_REVIEW → [QUALITY_REVIEW] → STATE_REVIEW → APPROVED → ISSUED`. District review
  needs **2 different officers**. Quality review applies only when the batch has **≥ `QUALITY_THRESHOLD` (default 50)**
  candidates. Any review stage can **return** a batch to the centre (to fix and resubmit) or **reject** it (final).
  A reason of at least 5 characters is required for both.
- **Rounds.** Approvals belong to a round. Resubmitting a returned batch starts round N+1, and earlier approvals no
  longer count, because the data may have changed. Old decisions stay in the audit trail.
- **CSV is the source of truth.** An upload replaces all candidates atomically. Every row is validated and every
  error is reported (spreadsheet row numbers, header = row 1). If any row is invalid, nothing is saved.
- **Issuance never waits on WhatsApp.** A batch becomes `ISSUED` and its certificates verify as `VALID` even if every
  message fails. Delivery is retried separately and can be re-queued after an outage.
- **Revocation never deletes.** The certificate keeps who revoked it, when and why. Verification shows `REVOKED` on the
  very next request (no cache), the PDF returns 410, and an unsent delivery is cancelled.
- **SLA.** A batch waiting more than `SLA_MINUTES` (default 2, a demo value) in a review stage is escalated once per
  stage visit, and shown to the state office.
- **Audit.** Every change writes an audit row in the same transaction. A database trigger makes the audit table
  append-only.
- **Demo sign-in.** You pick a seeded user; there are no passwords. Every permission is still enforced by the server.
  Identity comes only from the signed token, and the user is re-read from the database on every request.

## 2. Architecture

```
browser ──► nginx :8080 ──► api (Express, :4000, not published) ──► PostgreSQL 16
   ▲          (SPA + /api proxy, SSE)        │  ▲                       ▲
   └──── SSE /api/events ◄── Redis pub/sub ◄─┘  └── BullMQ (Redis 7) ──► worker
```

- **`apps/api`**: Express + TypeScript + Prisma. One image, two entrypoints: `src/server.ts` (HTTP) and
  `src/worker.ts` (BullMQ queues `certificates`, `delivery`, `maintenance`). Job logic lives in plain functions
  (`src/jobs/*`) that the tests call directly.
- **`apps/web`**: React + Vite, plain CSS, served by nginx. nginx proxies `/api` (SSE unbuffered on `/api/events`).
- **Live updates**: domain events are published to Redis `certiflow:events` after each commit. Every API instance
  subscribes and forwards them to its SSE clients, filtered by the same scope rules. This works with several API
  instances and with events raised by the worker.
- **Reliability**: issuance and delivery are idempotent. A reconciler (every 30s) re-enqueues APPROVED batches and
  PENDING deliveries that have gone stale. Redis runs with AOF persistence.

## 3. Screens

| Batch list, live ("Waiting for me") | Batch detail with certificates |
|---|---|
| ![Batches](apps/web/e2e/screenshots/03-batches-waiting-for-me.png) | ![Batch detail](apps/web/e2e/screenshots/05-batch-detail-certificates.png) |
| **Row-level CSV errors** | **State overview** |
| ![CSV errors](apps/web/e2e/screenshots/02-csv-errors.png) | ![State overview](apps/web/e2e/screenshots/10-state-dashboard.png) |

Screens: demo login, batches (tabs, live), batch detail (CSV upload, review actions, candidates, decisions,
certificates, audit timeline), state overview, simulated WhatsApp outbox, and public `/verify/:certNo`.

## 4. Key rules and how they are enforced

| Rule | Enforcement |
|---|---|
| One officer counts once per stage and round | Unique `(batchId, stage, round, actorId)` + `SELECT … FOR UPDATE` on the batch row |
| A batch advances exactly once under concurrent approvals | Row lock serialises decisions; the count happens under the lock |
| Exactly one certificate per candidate | Unique `candidateId` (and `(batchId, candidateId)`); issuance under a batch row lock |
| A WhatsApp retry never sends twice | Provider idempotency key = delivery id (`OutboundMessage.idempotencyKey` unique) |
| Status changes only through the state machine | `batchWorkflow.ts › TRANSITIONS` + `moveTo()`; nothing else writes `Batch.status` |
| Audit cannot be edited | Postgres trigger raises on `UPDATE`/`DELETE` of `"AuditLog"` |
| Public verification can't be enumerated | 50-bit random certificate numbers + Redis rate limit (60/min/IP) |
| Staff don't see candidates' full phone numbers | API masks phones (`******1234`) for every role except the owning centre |

## 5. API overview

All routes are under `/api`. "Scoped" means a batch outside your scope is 404.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/health`, `/health/ready` | public | Liveness; readiness checks Postgres and Redis (503 if either is down) |
| GET | `/auth/demo-users` | public | Seeded users (name, role, district/centre; no emails) |
| POST | `/auth/demo-login` | public | `{ userId }` → `{ token, user }` (HS256 JWT, 8h) |
| GET | `/me` | any signed-in user | Current user, re-read from the DB |
| GET | `/events?token=` | any signed-in user | Server-Sent Events, filtered by scope; heartbeat every 20s |
| POST | `/batches` | CENTRE | Create a DRAFT batch for the user's own centre |
| GET | `/batches?status=&escalated=true` | any signed-in user, scoped | List with candidate count, approvals this round, `decidedByMe`. `escalated` is STATE only |
| GET | `/batches/:id` | any signed-in user, scoped | Candidates (phones masked except for the owning centre), decisions, audit timeline |
| POST | `/batches/:id/candidates/csv` | CENTRE (own, DRAFT/RETURNED) | Multipart `file`, ≤1 MB, ≤500 rows. 422 `CSV_INVALID` with every row error |
| POST | `/batches/:id/submit` | CENTRE (own, DRAFT/RETURNED) | To district review; from RETURNED starts a new round |
| POST | `/batches/:id/decisions` | DISTRICT_OFFICER (same district) / QUALITY / STATE, by stage | `{ type: APPROVE\|RETURN\|REJECT, reason? }`. 409 `ALREADY_DECIDED` / `INVALID_STATE` |
| GET | `/batches/:id/certificates` | any signed-in user, scoped | Certificates with delivery status and attempts |
| GET | `/certificates/:certNo` | any signed-in user, scoped | One certificate with its delivery and audit timeline |
| GET | `/certificates/:certNo/pdf` | `?token=` (candidate link) or STATE / owning CENTRE | PDF rendered on demand; 410 if revoked; otherwise 403 |
| POST | `/certificates/:certNo/revoke` | STATE | `{ reason }`; 409 if already revoked; cancels an unsent delivery |
| POST | `/deliveries/retry-failed` | STATE | Re-queue FAILED deliveries after an outage |
| GET | `/public/verify/:certNo` | public, 60/min/IP | `{ status, certificateNo, candidateName, courseName, centreName, completionDate, issuedAt, revokedAt? }`; 404 `{ status: "INVALID" }`; 400 bad format; `Cache-Control: no-store` |
| GET | `/public/stats` | public, 60/min/IP | Aggregate counts for the landing page: certificates issued and currently valid |
| GET | `/stats` | STATE | Real counts: batches by status, certificates, deliveries by status, escalated |
| GET | `/dev/outbox` | STATE | Simulated WhatsApp outbox (phones masked) |
| GET | `/audit?entityType=&entityId=` | STATE | Audit rows (newest first) |

Errors are always `{ error: { code, message, details? } }`. A 500 never includes a stack trace.

## 6. Tests

`docker compose run --rm api npm test` runs **46 API tests in 7 files** against a real Postgres test database
(migrated and seeded by the global setup) and Redis. `npm run e2e -w apps/web` runs **7 Playwright browser tests**
against the running stack (not in CI; it needs every service). CI runs the API tests, a curl walkthrough
(`scripts/walkthrough.sh`, DRAFT → ISSUED → VALID → REVOKED), the web build, and `docker compose build`.

| Moment | Tests |
|---|---|
| **CSV upload** | invalid CSV reports row-level errors and saves nothing · duplicate candidate_ref is reported with both row numbers · valid CSV re-upload replaces candidates atomically · oversize 413 / non-CSV 422 / missing file 400 · e2e: rows 9–13 shown in the error table |
| **Concurrency** | the same officer cannot approve twice · concurrent approvals advance the batch exactly once (4 parallel requests, 5 iterations) · re-running issuance (sequentially and 3× concurrently) never duplicates certificates or deliveries · a stuck batch is escalated exactly once (3 runs, 2 concurrent) |
| **Issuance / WhatsApp** | a 60-candidate batch gets exactly 60 certificates with unique numbers · delivery retries after failures and timeouts and sends exactly one message · a timeout after the provider accepted does not send twice · a WhatsApp outage does not block issuance (+ retry-failed re-queues) · e2e: 60-candidate batch through quality review issues 60 certificates |
| **Revocation** | revoked certificates fail verification immediately (and the PDF is 410, a second revoke is 409, non-state is 403, the row is kept, audited) · delivery is cancelled for a revoked certificate · e2e: verify shows REVOKED after the revoke |
| **SLA** | a stuck batch is escalated exactly once (and cleared when it moves on) · a batch inside its SLA is not escalated |
| **Resubmission** | return and resubmit starts a new round; old approvals do not count · reject and return require a reason · e2e: the centre sees the return reason, round 2 at 0/2; reject leaves no actions |
| **Must never happen** | audit log rejects UPDATE and DELETE · no/tampered/expired token → 401 · centre approving / quality at district stage → 403 · another district's officer and another centre → 404 · public verify exposes only the allowed fields · demo-users exposes no emails · staff get masked phones · outbox masks phones · malformed JSON is 400, never 500 · SSE streams only visible events · stats/outbox are STATE only · PDF: wrong token 403, another centre 403 |
| **Other** | health and readiness · full path DRAFT → APPROVED audit trail · batch of 60 goes to QUALITY_REVIEW · submitting with no candidates is refused · public verify is rate limited · e2e: live list update over SSE, PDF download is `application/pdf`, sample CSV link downloads |

## 7. Out of scope / known limitations

- **Demo authentication.** You pick a seeded user; there are no passwords or SSO. All authorization is still enforced
  server-side.
- **Simulated WhatsApp.** A provider class records messages in `OutboundMessage` (see `/whatsapp` as state). It can be
  `flaky` (25% failure, 10% "accepted but slow"), `healthy` or `down`. No real WhatsApp Business API integration.
- **PDFs are rendered on demand** from database data on every download. Nothing is stored; object storage is in
  DEPLOYMENT.md.
- **No verification cache yet.** Every check reads Postgres, which is what makes revocation immediate. A cache would need
  invalidation on revoke.
- **The rate limiter fails open** if Redis is down (a deliberate availability choice, logged as a warning).
- **A revoke during an in-flight WhatsApp send** may still deliver that one message. The delivery is marked CANCELLED
  and verification shows REVOKED.
- **Limited test coverage of the plumbing:** `reconcile()` has no test, and BullMQ retry/backoff and the "out of
  retries → FAILED" event are exercised only by calling the functions directly (see docs/SELF_REVIEW.md #13).
- **Dev-only default secrets** (`JWT_SECRET`, `DOWNLOAD_TOKEN_SECRET`) let it run with no `.env`; the API and worker
  log a warning while they are in use.
- **No deployment.** It runs locally with Docker Compose; DEPLOYMENT.md is a plan, not something that exists.
- Not built: candidate self-service, bulk revocation, notifications other than WhatsApp, multi-language certificates.
