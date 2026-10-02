import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const run = promisify(execFile);
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));
const prismaBin = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url));

// The docker CLI finds Colima through its context, but testcontainers only speaks
// DOCKER_HOST or /var/run/docker.sock. Without this the suite reports a working
// runtime and then fails to connect to one.
//
// Colima's socket lives on the macOS filesystem, which the VM cannot bind-mount a
// socket from, so testcontainers' reaper container dies with "operation not supported"
// and takes every test with it. We stop containers explicitly below instead.
function useColimaSocket(): void {
  if (process.env.DOCKER_HOST) return;
  const socket = `${process.env['HOME']}/.colima/default/docker.sock`;
  if (!existsSync(socket)) return;
  process.env.DOCKER_HOST = `unix://${socket}`;
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
}

export async function isDockerUp(): Promise<boolean> {
  useColimaSocket();
  try {
    await run('docker', ['info'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export type TestDb = {
  prisma: PrismaClient;
  /** Passed to the app under test, so a test never points the composition root at another database. */
  url: string;
  stop: () => Promise<void>;
};

// Architecture section 8: integration tests run against a real Postgres, never a mock.
export async function startTestDb(): Promise<TestDb> {
  useColimaSocket();
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();

  await run(prismaBin, ['db', 'push', '--schema', schemaPath, '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  return {
    prisma,
    url: databaseUrl,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
