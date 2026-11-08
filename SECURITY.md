# Security policy

## Report a vulnerability

Report vulnerabilities through GitHub private vulnerability reporting: open the repository's **Security** tab and select **Report a vulnerability**. Don't open a public issue, PR, or discussion for a vulnerability.

Include:

- what an attacker can do, for example pass the gate without the required approvals, or get a write token to run PR code,
- the steps or the PR description and config that show it,
- the version or commit SHA of the action you tested.

## What counts

These are in scope:

- A way for a PR or its author to pass the gate without meeting its rules, or to raise its own tier of trust.
- A way to make the gate run untrusted code, or leak its token.
- A way to make the gate edit or post comments as another identity.

A wrong verdict on an unusual PR description is usually a bug, not a vulnerability. Open a normal issue for it.

## Supported versions

Tagged releases exist. The latest published GitHub Release is [v1.0.3](https://github.com/0xgui/agent-pr-gate/releases/tag/v1.0.3) (2026-10-28). The annotated tag `v1.0.3` points at commit `4dd96034b7e99d613b03c4eceb38264e349c442a`. The moving tag `v1` points at that same commit. [v1.0.2](https://github.com/0xgui/agent-pr-gate/releases/tag/v1.0.2) (2026-10-22) is also published, at commit `b8f3228e83e7ae46fb2b74bbfe22d09de8b6c39a`. Annotated tags `v1.0.0` and `v1.0.1` exist and were not published as GitHub Releases.

Fixes are commits on `main`. A tag contains a fix only when that tag's commit already has it. No support window, maintenance branch, or commitment to patch older tags is published.
