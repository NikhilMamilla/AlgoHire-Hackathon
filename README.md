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

## Requirements note
