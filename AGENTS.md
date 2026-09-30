# AGENTS.md

The project lives in `nairatrader-app/`. Its `AGENTS.md` is the authoritative one and is
**not** duplicated here:

- Read first: `nairatrader-app/PRD.md`, `nairatrader-app/Architecture-Essential.md` (D1–D13),
  `nairatrader-app/RISKS.md`.
- Stack, commands, hard rules and definition of done: `nairatrader-app/AGENTS.md`.
- Claude/agent-specific planning duties: `nairatrader-app/CLAUDE.md`.
- Toolchain pins and their reasons: `nairatrader-app/docs/adr/`.

Everything in this folder is documentation about that project; the only code is under
`nairatrader-app/apps` and `nairatrader-app/packages`. Do not create a second copy of a doc at
this level — that drift already happened once (the stale root `schema.prisma` predated decision
D13 and would have misled any agent that read it).
