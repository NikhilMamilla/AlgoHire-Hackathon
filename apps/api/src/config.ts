const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgresql://certiflow:certiflow@localhost:5432/certiflow',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
  qualityThreshold: Number(env.QUALITY_THRESHOLD ?? 50),
  slaMinutes: Number(env.SLA_MINUTES ?? 2),
  publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
};

// Prisma reads DATABASE_URL from env directly; make the default visible to it.
process.env.DATABASE_URL = config.databaseUrl;
