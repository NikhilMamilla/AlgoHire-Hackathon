# Setup

## Prerequisites

- **Docker Desktop** (or Docker Engine + Compose v2), running
- **Git**
- **Node 20+**: only to run the tests or the e2e outside Docker

## Run

```sh
git clone https://github.com/NikhilMamilla/AlgoHire-Hackathon.git
cd AlgoHire-Hackathon
docker compose up --build -d
docker compose ps        # wait until all 5 services show (healthy): postgres, redis, api, worker, web
```

Open **http://localhost:8080**. No `.env` is needed. The API runs migrations and an idempotent seed on start.

The API port (4000) is not published: all traffic goes through nginx on 8080. To reach the API directly while
debugging, uncomment its `ports:` block in `docker-compose.yml`.

## Demo users

| Name | Role | Scope |
|---|---|---|
| Anika | Training centre | Pragati Skill Centre, Kukatpally (Hyderabad) |
| Dev, Meera, Kabir | District officer | Hyderabad |
| Neha | Quality reviewer | State-wide (batches in quality review) |
| Farah | State office | Everything |

The **Warangal** district exists with no users. The tests use it to check that other districts can't see a batch.

## Sample CSVs

In `samples/` (also downloadable from the batch page at `/samples/*.csv`):

- `valid-10.csv`: 10 candidates, goes district → state
- `valid-60.csv`: 60 candidates, also goes through quality review (≥ 50)
- `invalid.csv`: errors on rows 9–13 (missing name, impossible date, duplicate ref, bad phone, wrong column count)

## Demo flow

Open http://localhost:8080. The landing page explains the product and shows live registry counts. Click
**Sign in to the demo**: the sign-in screen lists the demo users in three tiers (state office; district officers and
quality; training centre). Pick one to sign in. Each user lands on their home screen (Farah on **State overview**,
everyone else on **Batches**), and **Log out** in the top bar returns to sign-in.

1. Anika: **New batch**, upload `invalid.csv` (row errors, nothing saved), upload `valid-10.csv`, **Submit for review**.
2. Dev (in another browser or a private window): the batch appears in **Waiting for me** live. **Approve**. Then Meera approves.
3. Farah: **Approve**. The worker issues 10 certificates; WhatsApp delivery statuses update live.
4. Click a certificate number: the public **/verify** page shows **Valid**. As Farah, **Revoke** it with a reason;
   reloading verify shows **Revoked**.
5. Farah: **WhatsApp outbox** shows the simulated messages; **State overview** shows counts and escalated batches.

Or run the same flow from the command line (needs `curl` and `jq`): `bash scripts/walkthrough.sh`.

## Tests

```sh
docker compose run --rm api npm test     # 46 API tests, real Postgres test DB (certiflow_test) + Redis
```

Outside Docker (Node 20+, with the compose Postgres and Redis running, which publish 5432 and 6379):

```sh
npm install
TEST_DATABASE_URL=postgresql://certiflow:certiflow@localhost:5432/certiflow_test REDIS_URL=redis://localhost:6379 npm test
```

Browser e2e (optional; needs the full stack up):

```sh
npm install
(cd apps/web && npx playwright install chromium)   # once
npm run e2e -w apps/web                  # 15 tests; screenshots go to apps/web/e2e/screenshots/
```

## Reset

```sh
docker compose down -v                   # removes containers AND data volumes (Postgres, Redis)
```

## Configuration

All variables have defaults (see `.env.example`). Set them in your shell or in a `.env` file next to `docker-compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `QUALITY_THRESHOLD` | `50` | Batches with at least this many candidates also need quality review |
| `SLA_MINUTES` | `2` | Minutes in a review stage before a batch is escalated (demo value) |
| `WHATSAPP_MODE` | `flaky` | `flaky` (25% failures, 10% slow), `healthy`, or `down` |
| `PUBLIC_RATE_LIMIT` | `60` | Public verify requests per minute per IP |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Base for the QR code, verify and download links |
| `JWT_SECRET` | dev default | Signs login tokens. **Set it for anything real** (a warning is logged otherwise) |
| `DOWNLOAD_TOKEN_SECRET` | dev default | Signs candidate PDF links. **Set it for anything real** |

### Demo a WhatsApp outage

```sh
WHATSAPP_MODE=down docker compose up -d worker      # PowerShell: $env:WHATSAPP_MODE="down"; docker compose up -d worker
```

Approve a batch: it is still **ISSUED** and certificates verify **VALID**, but deliveries keep failing. After 6 attempts
(about a minute of backoff) they show **Failed**. Restore with `docker compose up -d worker` (back to `flaky`) and
click **Retry failed deliveries** on the State overview.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port is already allocated` (8080, 5432 or 6379) | Stop whatever uses the port, or change the host side of the `ports:` mapping in `docker-compose.yml` |
| `Cannot connect to the Docker daemon` / `docker: command not found` | Start Docker Desktop and wait until it says it is running; open a new terminal so `docker` is on PATH |
| The API is unhealthy and its logs show it connecting to `localhost:5432` | You copied `.env.example` to `.env` with the `DATABASE_URL` / `REDIS_URL` lines uncommented. Leave them commented for Docker (they are only for running outside Docker) |
| `docker compose run --rm api npm test` fails with `certiflow_test does not exist` | The test DB is created on Postgres's first start. Run `docker compose down -v` and start again |
| `docker compose up --build` fails in the web build with "The cloud operation was unsuccessful" | The repo is in a OneDrive folder and Playwright output was in the build context as cloud-only files. `.dockerignore` excludes `test-results/`, `playwright-report/` and `apps/web/e2e`; delete any stray `test-results` folder, or pass `--output` outside the repo when running Playwright |
| The web page loads but lists don't update live | Check `docker compose logs api` for Redis errors; the SSE stream is `/api/events` |
