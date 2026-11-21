import { execSync } from 'node:child_process';

// Migrate the separate test database before any test runs.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://certiflow:certiflow@localhost:5432/certiflow_test';
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
