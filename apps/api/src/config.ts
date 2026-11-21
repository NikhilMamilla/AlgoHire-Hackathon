const env = process.env;

// Dev-only defaults so `docker compose up` works with no .env. Never use them in a real deployment.
const DEV_JWT_SECRET = 'dev-secret-change-me';
const DEV_DOWNLOAD_SECRET = 'dev-download-secret-change-me';

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgresql://certiflow:certiflow@localhost:5432/certiflow',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET ?? DEV_JWT_SECRET,
  qualityThreshold: Number(env.QUALITY_THRESHOLD ?? 50),
  slaMinutes: Number(env.SLA_MINUTES ?? 2),
  publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
  downloadTokenSecret: env.DOWNLOAD_TOKEN_SECRET ?? DEV_DOWNLOAD_SECRET,
  whatsappMode: (env.WHATSAPP_MODE ?? 'flaky') as 'flaky' | 'healthy' | 'down',
  // Getter: read per request so it can be tuned at runtime (and lowered in tests).
  get publicRateLimit() {
    return Number(env.PUBLIC_RATE_LIMIT ?? 60);
  },
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
};

// Prisma reads DATABASE_URL from env directly; make the default visible to it.
process.env.DATABASE_URL = config.databaseUrl;

/** Names of secrets still on their dev defaults; logged as a warning at startup by server and worker. */
export const devSecretsInUse = () =>
  [
    config.jwtSecret === DEV_JWT_SECRET && 'JWT_SECRET',
    config.downloadTokenSecret === DEV_DOWNLOAD_SECRET && 'DOWNLOAD_TOKEN_SECRET',
  ].filter(Boolean) as string[];
