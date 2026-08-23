# Contributing

Rivet is a single-maintainer portfolio project, but bug reports, security-minded review,
documentation fixes, and focused pull requests are welcome.

## Before opening an issue

- Search existing issues first.
- Use GitHub private vulnerability reporting for security problems. Do not publish credentials or
  exploit details in an issue.
- Include the smallest reproduction you can provide.
- State whether the problem occurs in the database-free unit suite, the integration suite, or the
  Docker sandbox suite.

## Development setup

Rivet requires Node.js 24 and pnpm 10.32.0.

```bash
git clone https://github.com/xuanhieu2611/Rivet.git
cd Rivet
corepack enable
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

These checks need no database, Redis, or Docker. The infrastructure suites and local service setup
are documented in the [README](README.md).

## Pull requests

Keep changes focused and explain the behavior they preserve or change. Add tests for behavior
changes and update the relevant documentation. Before opening a pull request, run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Infrastructure changes should also run the applicable integration, streaming, or sandbox suite. Pull
requests may take time to review and may not be merged if they do not fit the project's current
scope.

By contributing, you agree that your contribution is licensed under the repository's
[MIT License](LICENSE).
