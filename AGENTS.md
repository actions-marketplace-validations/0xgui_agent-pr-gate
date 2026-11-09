# Working on agent-pr-gate as an agent

This file is for coding agents that change this repository. People can read it too. [CONTRIBUTING.md](CONTRIBUTING.md) has the short version.

If you are an agent whose PR is gated by this action in another repository, you want the README instead: [Use it from an agent](README.md#use-it-from-an-agent) explains the JSON verdict and how to loop on it.

agent-pr-gate is a TypeScript GitHub Action that runs on Node 24 (`runs.using: node24` in `action.yml`). It has no runtime service of its own: it reads and writes through the GitHub API only.

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
| `src/scope.ts` | Which PRs are in scope (`scope` in the config), and what forces a PR into scope |
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
| `examples/` | Workflows for repositories that use the action. `test/workflows.test.ts` checks their job IDs |
| `action.yml` | Inputs, outputs, and the entry point (`dist/index.js`) |
| `.review-gate.yml` | This repository's own gate config: tiers, approvals, owner override, round cap |
| `.github/workflows/ci.yml` | Lint, types, tests, build, and a check that `dist/` is fresh |
| `.github/workflows/gate.yml` | This repository's own gate run. A smoke test, not a required check |

## Check your change

Install once, then run the full check before every push:

```sh
npm ci
npm run all
```

| Script | What it runs |
| --- | --- |
| `npm run lint` | ESLint over the repository |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | The full Vitest suite (`vitest run`) |
| `npm run verify` | A quick subset: `test/solo.test.ts` and `test/comment.test.ts` |
| `npm run build` | esbuild bundles `src/index.ts` into `dist/index.js` and `src/bin.ts` into `dist/cli.js` |
| `npm run all` | lint, typecheck, test, and build, in that order |

CI (`.github/workflows/ci.yml`) runs `npm ci`, lint, typecheck, test, and build on Node 24, then fails if `git diff --exit-code -- dist/` shows any change.

### dist/ is generated, and committed

Never edit `dist/` by hand. After any change under `src/`, run `npm run build` and commit `dist/index.js` and `dist/cli.js` in the same commit as the source change. A docs-only or test-only change should leave `dist/` untouched. If `git status` shows `dist/` changed after a build when you didn't touch `src/`, find out why before you commit.

Some tests read repository files, so docs changes can break them:

- `test/workflows.test.ts` parses the first `yaml` block in `README.md` that contains `pull_request_target`, and expects the gate job ID `agent-pr-gate-job`.
- `test/placeholders.test.ts` reads the "Worked examples" table in `docs/evidence-rule.md`.
- `test/repo-config.test.ts` expects `REVIEW_POLICY.md` to mention `rounds.cap: 2`.

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

### What this repository's gate expects

This repository gates its own PRs with `.review-gate.yml`. The highest tier across the changed files wins:

| Tier | Paths | Approvals |
| --- | --- | --- |
| low | `docs/**`, `*.md`, `examples/**` | 0 |
| medium | `src/**`, `test/**`, and anything that matches no glob | 1 |
| high | `.github/workflows/**`, `.github/CODEOWNERS`, `.review-gate.yml`, `action.yml`, `dist/**` | 2, plus a CODEOWNERS approval |

A source change usually changes `dist/` too, which makes the PR high tier. Keep docs and tests in separate PRs from source changes when you can, so they stay low or medium tier.

The required sections are Testing, Risk, and How to revert (aliases `Rollback` and `Revert plan`), and CI must be green. The owner override waives approvals for the maintainer's own low and medium PRs only. High-tier PRs and PRs that touch gate-control files are never waived. See [REVIEW_POLICY.md](REVIEW_POLICY.md).

## Don't

- Don't edit `dist/` by hand, or commit a `dist/` that doesn't match `npm run build`.
- Don't loosen the evidence rule without the spec-first steps above.
- Don't add a dependency on an outside service. The action talks only to the GitHub API.
- Don't check out or run PR code in a gate workflow, or widen the permissions in `examples/` or the README.
- Don't change a pinned action SHA or the version in `package.json` in a feature PR. A release bumps them in its own PR.
- Don't commit secrets, tokens, local paths, logs, or editor and agent tool directories. `.gitignore` covers the common ones.

## Follow the review policy

[REVIEW_POLICY.md](REVIEW_POLICY.md) limits each PR to 2 review rounds. After the second round, fix only blockers in the PR. File other findings as issues with the `follow-up` label.
