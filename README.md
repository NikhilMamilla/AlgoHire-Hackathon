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

## Requirements note
