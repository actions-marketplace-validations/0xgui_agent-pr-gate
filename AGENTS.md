# Working on agent-pr-gate as an agent

This file is for coding agents that change this repository. People can read it too. [CONTRIBUTING.md](CONTRIBUTING.md) has the short version.

## Repository layout

| Path | What it holds |
| --- | --- |
| `src/index.ts` | Action entry point. Calls `run()` in `src/main.ts` |
| `src/main.ts` | The action: inputs, writes (comment, labels, review requests, status), and the sweep |
| `src/evaluate.ts` | The read-only half: reads a PR through the API and decides (`judgePr`). Shared by the action and the CLI |
| `src/cli.ts` | The `check` CLI: arguments, settings, and the JSON verdict |
| `src/bin.ts` | CLI entry point. Calls `cli()` in `src/cli.ts` |
| `src/gate.ts` | The decision (`decide`), the comment (`renderComment`), the owner override, and `GATE_CONTROL_FILES` |
| `src/evidence.ts` | Section parsing and the rule that decides whether a line is real content |
| `src/config.ts` | `.review-gate.yml` parsing and the defaults (`defaultConfig`, `DEFAULT_SECTIONS`) |
| `src/tiers.ts` | Risk tiers from changed paths |
| `src/codeowners.ts` | CODEOWNERS parsing and coverage |
| `src/reviews.ts` | Approvals and review rounds |
| `src/ci.ts` | The CI verdict from check runs and statuses |
| `src/state.ts` | The hidden state marker and the fingerprint |
| `src/sweep.ts` | Sweep planning and the rate budget |
| `src/writes.ts` | Write helpers and the stability check |
| `src/metrics.ts` | Metrics and revert detection |
| `test/` | Vitest tests. `placeholders.test.ts` builds the evidence matrix from `docs/evidence-rule.md` |
| `docs/evidence-rule.md` | The evidence rule and its worked examples |
| `dist/index.js` | The bundled action that `action.yml` runs. Generated, but committed |
| `dist/cli.js` | The bundled CLI (`bin` in `package.json`). Generated, but committed |
| `examples/` | Workflows for repositories that use the action |
| `.github/workflows/ci.yml` | Lint, types, tests, build, and a check that `dist/` is fresh |
| `.github/workflows/gate.yml` | This repository's own gate run. A smoke test, not a required check |

## Check your change

Run this before every push:

```sh
npm ci
npm run all
```

`npm run all` runs lint, the type check, the tests, and the build. The build rewrites `dist/index.js` and `dist/cli.js`. Commit both in the same commit as the source change. CI fails when `dist/` doesn't match the source.

## Change the evidence rule spec first

`docs/evidence-rule.md` is the specification of the evidence rule. `test/placeholders.test.ts` reads every row of its "Worked examples" table and checks the row inside every wrapper it knows: lists, quotes, tables, bold labels, task boxes, and HTML.

To change the rule:

1. Edit the rule text in `docs/evidence-rule.md`.
2. Add a row for each case, with the verdict `empty` or `filled`.
3. Run the tests on the old code and confirm that the new rows fail.
4. Change `src/evidence.ts` until every row passes.

A change that turns any line from empty to filled loosens the gate. Before you open such a PR, run the old and the new `checkEvidence` over every spec row in every wrapper, and list each row that changed from empty to filled. To get the old code, use `git show origin/main:src/evidence.ts`. Put the result in the PR description. Expect a request for rows that cover plans and deferrals, such as `N/A: later` or `Will add 3 test cases; e2e: TODO`.

## Write commits and PRs

- Use Conventional Commits: `type(scope): subject`, for example `fix(evidence): treat an unchecked box as empty`.
- Push new commits. Never force-push, rewrite pushed history, or skip hooks.
- Base each PR on the latest `main`, and keep it to one concern.
- Fill in every section of the PR template (`.github/pull_request_template.md`): Summary, Testing, Risk, and How to revert. Report the commands you ran and their results in Testing, for example `npm run all: 412 tests passed`. The gate blocks a PR whose sections hold only placeholders.
- Link the issue that the PR closes.
- Don't merge your own PR. A maintainer merges.

## Follow the review policy

[REVIEW_POLICY.md](REVIEW_POLICY.md) limits each PR to 2 review rounds. After the second round, fix only blockers in the PR. File other findings as issues with the `follow-up` label.
