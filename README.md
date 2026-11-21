# CertiFlow

Skilling certificate issuance platform.

## Run

```sh
docker compose up --build
```

- Web: http://localhost:8080
- API: http://localhost:4000/api/health/ready

## Tests

In Docker (uses the `certiflow_test` database, migrated automatically before tests):

```sh
docker compose run --rm api npm test
```

Locally, with the compose `postgres` and `redis` services up:

```sh
docker compose up -d postgres redis
npm install
npm test
```

## Authentication (demo)

This is demo auth: `GET /api/auth/demo-users` lists the seeded accounts and `POST /api/auth/demo-login { userId }`
returns an 8h HS256 JWT. There are no passwords. Authorization is still fully enforced server-side: identity comes
only from the Bearer token, the user and role are re-loaded from the database on every request, and every
role and scope check runs in the API.

## Batch workflow

`DRAFT -> DISTRICT_REVIEW -> (QUALITY_REVIEW if candidates >= QUALITY_THRESHOLD) -> STATE_REVIEW -> APPROVED`.
Any review stage can `RETURN` (back to the centre to fix and resubmit) or `REJECT` (terminal). District review needs
2 distinct officers' approvals. All transitions live in `apps/api/src/batchWorkflow.ts`; decisions take a
`SELECT ... FOR UPDATE` row lock, and a unique `(batchId, stage, round, actorId)` constraint guarantees one officer
counts once.

**Round policy:** approvals belong to a round. A resubmitted batch starts a new round, so earlier approvals no longer
count and the batch needs fresh approvals, because the data may have changed since they were given. Old decisions are
kept for the audit trail.

**Audit log** is append-only: a row-level trigger rejects `UPDATE`/`DELETE` on `"AuditLog"`. Tests reset data with
`TRUNCATE`, which does not fire row-level triggers.

## Certificates, delivery, verification

- On `APPROVED` the API enqueues `issue-certificates` (BullMQ). The worker issues one certificate per candidate
  (`CF-` + 10 Crockford base32 chars, 50 random bits) in one locked transaction and moves the batch to `ISSUED`.
  Re-running issuance is a no-op. Issuance never waits on WhatsApp.
- Each certificate gets one delivery job sent through a simulated WhatsApp provider (`WHATSAPP_MODE=flaky|healthy|down`).
  Sends are idempotent on the delivery id, so a retry after "accepted but timed out" never sends twice. After 6 failed
  attempts a delivery is `FAILED`; `POST /api/deliveries/retry-failed` (state) re-queues them.
- A reconciler runs every 30s and re-enqueues stale `APPROVED` batches and stale `PENDING` deliveries, covering a crash
  between commit and enqueue or lost Redis data. Redis also runs with AOF persistence.
- `GET /api/public/verify/:certNo` needs no login, always reads Postgres (`Cache-Control: no-store`) and is rate
  limited per IP in Redis (`PUBLIC_RATE_LIMIT`, default 60/min).
- `GET /api/certificates/:certNo/pdf` renders the PDF on demand. It is allowed with the candidate's signed `?token=`
  link, or for state staff and the owning centre. A revoked certificate returns 410.
- Revocation (state only) never deletes. It records who, when and why, and cancels an unsent delivery.

## Requirements note
