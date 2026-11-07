# Contributing

Thanks for your interest. This project is an independent desktop application for
[OMP](https://omp.sh); it is not part of OMP and is not maintained by its authors.

## Before opening an issue

- Run `bun run typecheck`, `bun test tests/unit`, and `bunx playwright test` to
  confirm the problem is not local.
- Describe the system (Windows x64), the app version, and the OMP version
  (`omp --version`).
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening an
  issue.

## Environment

```powershell
bun install --ignore-scripts
node node_modules/electron/install.js
bun run dev
```

Requirements: Windows x64, Bun 1.4+, and OMP installed. Git is only needed for
the Changes panel.

Node.js is required for the Electron download step in development. It is separate
from the optional Node.js LTS that the app can install for projects/MCP; the app
does not require a system Node.js to run.

## Conventions

- **Code language**: identifiers in English; comments and interface messages in
  Brazilian Portuguese, with the three translations (`src/renderer/i18n`).
- **Contracts**: `src/shared/contracts.ts` and `src/shared/session-types.ts` are
  shared by main, host, and renderer. If you change one, update all three sides.
- **Product rules** (do not break):
  1. the app never approves anything on its own;
  2. Stop is always visible while the agent is working;
  3. unknown values appear as "Unavailable", never 0%;
  4. cost is always "estimated" and comes from `get_session_stats`;
  5. the runner shows the effective and configured models separately;
  6. states never rely on color alone;
  7. no prompt is ever resent automatically.
- **Tests**: relevant behavior gets a test. Use the test OMP
  (`tests/fixtures/fake-omp.ts`) in acceptance; do not spend quota in automated
  tests.

## Pull requests

1. One change per PR, with the reason in the title.
2. `bun run typecheck`, `bun test tests/unit`, and `bunx playwright test` green.
3. If you change the interface, attach a screenshot of the real window.
4. Do not include personal data (paths containing a username, emails, tokens) in
   screenshots, fixtures, or logs.
