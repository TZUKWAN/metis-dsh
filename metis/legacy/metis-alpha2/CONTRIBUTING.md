# Contributing to Metis in Social Science

Thank you for improving Metis. The project is in early alpha, so focused changes with
clear evidence are easier to review than broad rewrites.

## Before you start

1. Search the [issue tracker](https://github.com/TZUKWAN/metis-in-social-science/issues)
   for an existing report or proposal.
2. For a substantial behavioral or architectural change, open an issue first and
   describe the use case, proposed boundary, and validation plan.
3. Never include API keys, private papers, user databases, absolute local paths, or
   confidential research content in an issue, commit, fixture, screenshot, or log.

## Development setup

```bash
npm install
npm run rebuild:electron
npm run typecheck
npm run dev:electron
```

`better-sqlite3` uses different native ABIs under Node.js and Electron. `npm test`
rebuilds it for Node.js. Run `npm run rebuild:electron` again before launching the
desktop application.

## Required checks

Before submitting a pull request, run:

```bash
npm run typecheck
npm run lint
npm test
npm run rebuild:electron
npm run build
```

Add focused regression tests for every behavior change. Do not weaken strict runtime
contracts, skip failing tests, or replace integration evidence with a mock when the
real boundary can be exercised.

## Pull requests

- Keep each pull request centered on one problem.
- Explain the user impact, implementation, tests, and any remaining risk.
- Include before/after screenshots for visible UI changes.
- Preserve renderer isolation and validate all IPC input and output.
- Update README or release documentation when commands or user-facing behavior change.

By contributing, you agree that your contribution is licensed under the MIT License.

