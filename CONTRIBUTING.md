# Contributing

Thank you for helping. This guide covers changes to agent-pr-gate itself. To use the action, see the [README](README.md).

## Before you start

- For a bug, open an issue with the PR description or config that shows it, the gate comment, and what you expected.
- For a new feature, open an issue first, so that we can agree on the behavior before you write code.
- For a security problem, don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Make a change

1. Fork the repository and create a branch from `main`.
2. Run `npm ci`.
3. Make the change, with tests. For the evidence rule, change [docs/evidence-rule.md](docs/evidence-rule.md) first, as described in [AGENTS.md](AGENTS.md).
4. Run `npm run all`. It runs lint, the type check, the tests, and the build.
5. Commit the rebuilt `dist/index.js` and `dist/cli.js` together with your source change.
6. Open a PR and fill in the template: Summary, Testing, Risk, and How to revert.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(reviews): ignore bot reviews in round counting`.

[REVIEW_POLICY.md](REVIEW_POLICY.md) explains how PRs are reviewed. [AGENTS.md](AGENTS.md) has the repository layout and the rules for agents.

## License

agent-pr-gate is released under the [MIT License](LICENSE). By sending a contribution, you agree that it is licensed under the same terms.
