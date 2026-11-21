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

## Requirements note
