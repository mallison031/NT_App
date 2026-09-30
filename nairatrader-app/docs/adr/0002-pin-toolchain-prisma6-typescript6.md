# 2. Pin the toolchain: Prisma 6 and TypeScript 6

Date: 2026-09-30

## Status
Accepted

## Context
Phase 0 installed current majors and both broke the repo's documented assumptions.

- Prisma 7 rejects `datasource.url = env("DATABASE_URL")` in `schema.prisma`; connection URLs
  move to `prisma.config.ts` and the client constructor requires a driver adapter. That means
  adding `@prisma/adapter-pg` plus `pg` and rewriting every client instantiation, for no product
  gain at this stage. The schema in `apps/api/prisma/schema.prisma` was authored for the classic
  model, as were Architecture sections 5 and 7.
- The same schema could not be parsed at all as delivered: its `generator`, `datasource` and all
  ten `enum` blocks were written on single lines, which Prisma's grammar rejects (P1012, 27
  validation errors). They are now expanded one definition per line.
- TypeScript 7 removed `baseUrl` and typescript-eslint 8 refuses to run against the TS 7 parser
  API, so `pnpm lint` could not start at all.

## Decision
Pin `prisma` / `@prisma/client` to 6.x and `typescript` to 6.x across the workspace. Keep
`moduleResolution: "Bundler"` (imports without file extensions, `tsc --noEmit` only; nothing is
emitted, `tsx` runs the source).

## Consequences
- Lint and typecheck work as a set today. Both pins are recorded in the manifests, so a future
  `pnpm update` that jumps a major will show up as a deliberate change, not drift.
- Adopting Prisma 7 later is its own migration: `prisma.config.ts`, a driver adapter, and
  regenerated clients in an explicit `output` path. Budget it as a task, not an update.
- Revisit the TypeScript pin when typescript-eslint ships TS >= 7.1 support
  (typescript-eslint issue 10940).
- With pnpm, `prisma generate` must run from `apps/api` (root scripts already do this via
  `pnpm --filter api`), otherwise the generated client lands where Node cannot resolve it.
