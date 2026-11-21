# Build context: repo root. One image, two compose services (api, worker).
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# dev deps kept: tsx runs the TS entrypoints and `npm test` runs in this image.
RUN npm ci -w apps/api
COPY apps/api apps/api
# Sample CSVs: the test suite uploads them (`docker compose run --rm api npm test`).
COPY samples samples
WORKDIR /app/apps/api
RUN npx prisma generate
EXPOSE 4000
CMD ["npx", "tsx", "src/server.ts"]
