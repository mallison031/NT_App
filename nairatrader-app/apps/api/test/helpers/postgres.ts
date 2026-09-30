import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const run = promisify(execFile);
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));
const prismaBin = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url));

export async function isDockerUp(): Promise<boolean> {
  try {
    await run('docker', ['info'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export type TestDb = {
  prisma: PrismaClient;
  stop: () => Promise<void>;
};

// Architecture section 8: integration tests run against a real Postgres, never a mock.
export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();

  await run(prismaBin, ['db', 'push', '--schema', schemaPath, '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  return {
    prisma,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
