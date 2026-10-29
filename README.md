# agent-pr-gate

A GitHub Action that checks pull requests from AI agents before a human reviews them.

## Why

Agents open PRs faster than people can review them. Many of those PRs arrive with no test results, no risk note, and no plan to revert. agent-pr-gate is not another AI reviewer. It decides who must look at a PR and what proof the PR needs. Then it tells the author, often an agent, exactly what is missing, in one comment that it keeps up to date. Reviewers start from a PR that already has its evidence.

On every PR event, the gate:

1. Sets a risk tier from the changed paths: `risk:low`, `risk:medium`, or `risk:high`. The highest tier across the changed files wins.
2. Checks the evidence. The PR description needs filled-in `Testing`, `Risk`, and `How to revert` sections, and CI on the head commit must be green.
3. Routes reviews. By default, low needs no approval, medium needs 1, and high needs 2 plus a CODEOWNERS approval. The gate requests code owners as reviewers.
4. Caps review rounds. After 3 review and fix rounds, it tells the author to step back, adds the `needs-human` label, and requests the maintainers.
5. Reports metrics: time to first human review, human approvals, review rounds, and reverts.

The verdict is the step result, a commit status named `agent-pr-gate`, the step outputs, and the PR comment.

## Set it up

You need a repository with a CI workflow and permission to edit branch protection.

> **Important:** Under GitHub's current rules, `pull_request_target` and `workflow_run` always run the workflow file from the **default branch**. That's true whatever the PR's base branch is. So the gate does nothing until its workflow is on the default branch, and the PR that adds it isn't gated. Merge the setup PR first, then open a PR to see the gate. The gate still reads `.review-gate.yml` and CODEOWNERS from each PR's base commit.

1. Create `.github/workflows/agent-pr-gate.yml` in the repository you want to gate:

	```yaml
	name: agent-pr-gate
	on:
	  # Runs the workflow from the default branch with a write token, also for fork PRs.
	  # Never check out or run PR code in this workflow.
	  pull_request_target:
	    types: [opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled]
	  workflow_run:
	    workflows: [CI]        # the name of your CI workflow; re-runs the gate when CI finishes
	    types: [completed]

	permissions:
	  contents: read        # read .review-gate.yml and CODEOWNERS
	  pull-requests: write  # labels and review requests
	  issues: write         # the gate comment
	  checks: read          # the CI verdict
	  actions: read         # find the gate's own job checks
	  statuses: write       # the agent-pr-gate commit status

	jobs:
	  agent-pr-gate-job:
	    runs-on: ubuntu-latest
	    steps:
	      - uses: 0xgui/agent-pr-gate@2da570e75f377b413e19bdfc338dab7c9e881538 # v1.0.3
	        with:
	          ci-wait-seconds: '300'   # about as long as your CI usually takes
	```

	Pin the action to a full 40-character commit SHA and keep the version in a comment. The example pins `v1.0.3`. The tag `v1` points to the latest `v1.x.y` release. `@v1` is easier to keep current, but whoever can move that tag controls your gate, so a SHA is safer. Don't use a branch name such as `@main`.

2. Merge the workflow into the default branch. Then open a PR. The gate posts its comment and sets the `agent-pr-gate` commit status.
3. In branch protection, make the `agent-pr-gate` commit status a required check. Keep required reviews and code owner review turned on. The gate reports and routes. Branch protection is what enforces reviews.

Require only the `agent-pr-gate` commit status. Don't require the `agent-pr-gate-job` job check. The job check is named after the job ID, and it can be green when the PR isn't: a stale run (the PR changed during the check) writes no status and passes. With `fail-on-block: 'false'`, a blocked run passes too. Keep the job ID different from the status context, so a required `agent-pr-gate` can only match the status.

Use the same job ID, `agent-pr-gate-job`, in every workflow that runs the gate, including the scheduled re-check. The gate skips a check run named like its job ID only when that check's workflow run comes from a workflow file where the job uses this action, so its own checks from any run (also failed or cancelled earlier runs) are skipped, and a CI job with the same name in another workflow still counts. A re-check job with another ID would count the event job's check as CI. If you use another job ID, add it to `ignore-checks`, which skips by name.

This needs `actions: read`. When a check run shares the job's name, the gate lists the workflow runs for the head SHA (one call, cached per SHA) and reads the workflow file of each such run (cached per file and ref, so a sweep reads a default-branch file once). That is about one more API call per checked PR, which the sweep budget includes. Without `actions: read`, the gate warns and falls back to skipping every check run named like the job ID.

`ci-wait-seconds` makes the first run wait for your CI. With `0`, the first status is often `ci:pending`, and the gate runs again through `workflow_run` when CI finishes. That re-run also works only from the default branch. A higher value holds a runner while the gate waits, so set it to about your CI's usual duration.

### Try it on a branch

The gate runs on PRs to any branch, but always from the workflow on the default branch. So a gate workflow that exists only on a test branch never runs. To try it before merging, add a temporary copy of the workflow that runs on `pull_request` instead of `pull_request_target`, on the branch your test PRs target, and branch the test PRs from it. `pull_request` runs the workflow file from the PR itself, and fork PRs get a read-only token, so delete the copy before you merge.

The default `github-token` is enough. Without a config file, every file gets the `medium` tier.

For reviews on fork PRs and for a scheduled backstop, also add the workflows in [`examples/`](examples). The full example, [`examples/workflow.yml`](examples/workflow.yml), adds a concurrency group and the metrics artifact. [`examples/review-relay.yml`](examples/review-relay.yml) re-runs the gate after a review. [`examples/recheck.yml`](examples/recheck.yml) re-checks all open PRs every 30 minutes.

## Start with a small config

Put `.review-gate.yml` on the default branch. Every key is optional. This config marks docs as low risk and workflows as high risk:

```yaml
tiers:
  low: ["docs/**", "*.md"]
  high: [".github/workflows/**", "infra/**"]
maintainers: [your-handle]   # requested when a PR hits the round cap
```

The gate reads the config and CODEOWNERS from the base commit, so a PR can't change its own rules. [Configuration](#configuration) lists every key.

## Read the comment

The gate keeps one comment per PR and edits it in place. A blocked PR looks like this:

```markdown
## ❌ agent-pr-gate: blocked

**Risk tier:** `medium` (needs 1 approving review(s))

**Why `medium`:**
- `src/a.ts` matches no tier glob, so it gets default_tier `medium`

**Approvals:** 0/1
**CI:** green
**Review/fix rounds:** 0/3

### What is missing

1. **"## Testing" section is empty or only TODO**
   - Where: PR description
   - Fix: Add a "## Testing" heading with real content (template below). Edit the PR description; no new commit needed.
   - Who: author
2. **Needs 1 approving human review(s), has 0**
   - Where: PR reviews
   - Fix: 1 more approval(s) on the current head commit from people with repo access, other than the author. Bot approvals do not count.
   - Who: reviewer
```

Each missing item says where the problem is, how to fix it, and who has to act. For a missing or empty section, the comment also has a template to paste into the description. When everything passes, the same comment changes to "all requirements met".

## Use it from an agent

The comment ends with a collapsed "Machine-readable result" block that holds JSON:

```json
{
  "schema_version": 1,
  "gate": "blocked",
  "tier": "medium",
  "forced": null,
  "triggers": [{ "file": "src/a.ts", "glob": null, "config_line": null }],
  "missing": [
    {
      "id": "section-empty:testing",
      "who": "author",
      "what": "\"## Testing\" section is empty or only TODO",
      "where": "PR description",
      "fix": "Add a \"## Testing\" heading with real content (template below). Edit the PR description; no new commit needed.",
      "section": "Testing"
    },
    {
      "id": "approvals",
      "who": "reviewer",
      "what": "Needs 1 approving human review(s), has 0",
      "where": "PR reviews",
      "fix": "1 more approval(s) on the current head commit from people with repo access, other than the author. Bot approvals do not count.",
      "reviewers": ["lead"]
    }
  ],
  "approvals": { "have": 0, "need": 1 },
  "codeowners_required": false,
  "owner_override": null,
  "rounds": { "count": 0, "cap": 3, "cap_reached": false }
}
```

`schema_version` changes only when the JSON changes in a way that can break a reader. Each item in `missing` has `id`, `who`, `what`, `where` and `fix`. Some items have more fields:

- `section`: the required section, for section codes
- `checks`: the checks that failed or are still running, for `ci:failing` and `ci:pending`
- `files`: the high-tier files that still need a code owner, for `codeowners`
- `reviewers`: who can approve, for `approvals` and `codeowners`. The author is never listed. An empty list means that the config and CODEOWNERS name nobody else
- `cause`: why the requirement can't be met as configured. `no-other-reviewer` means only the author is listed in `maintainers` (and CODEOWNERS), or every open high-tier file is owned only by the author. `no-codeowners-file` means `high_requires_codeowners` is `true` but there is no CODEOWNERS file. See [One-person repositories](#one-person-repositories)

`missing[].id` is one of these codes. Each code is `kind` or `kind:detail`:

| Code | Meaning | Who acts |
| --- | --- | --- |
| `section-missing:<name>` | The description has no heading for a required section. `<name>` is the section name in lower case, with each run of other characters replaced by `-`, for example `section-missing:how-to-revert` | author |
| `section-empty:<name>` | The section heading is there, but the section holds only placeholders | author |
| `ci:failing` | A check or status on the head commit failed | author |
| `ci:pending` | A check is still running | author |
| `ci:none` | The head commit has no checks | author |
| `approvals` | Not enough approving reviews on the head commit | reviewer |
| `codeowners` | A high-tier file has no approval from its code owner | reviewer |
| `files:incomplete` | The PR changes more than 3000 files, so the gate can't see them all | reviewer |
| `rounds:unknown` | The gate couldn't read the PR timeline to count review rounds | reviewer |

In a workflow, read the same verdict from the step outputs: `result`, `tier`, and `missing` (a JSON list of codes).

An agent can loop on the gate like this:

1. Open the PR with every required section filled in. If the repository sets [`scope`](#limit-the-gate-to-agent-prs), check that the PR is in scope. The repository's PR template is a good start.
2. Wait for the `agent-pr-gate` commit status.
3. If the status fails, read the JSON block in the gate comment.
4. Fix every item where `who` is `author`. For `section-missing`, add the heading. For `section-empty`, replace the placeholders with what you ran and its result. Section fixes need only a description edit, not a new commit. CI fixes need a new commit.
5. Leave the items where `who` is `reviewer` to people. To ask for a review, request one from `reviewers`. Don't ask bots to approve. Bot approvals never count.
6. Stop when `rounds.cap_reached` is `true`. Summarize what is still open and wait for a human.

The gate judges a section by what each line says, not by its length. A line counts as empty when it holds only placeholders, such as `TODO`, `TBD`, `N/A`, `WIP`, or a line that starts with an unchecked box (`- [ ]`). Report what you ran and its result, for example `npm test: 42 passed`. [docs/evidence-rule.md](docs/evidence-rule.md) has the full rule with worked examples.

## Relax the rules

Use these settings when the defaults are too strict for your repository:

- To stop requiring sections, set `evidence.sections: []`.
- To stop requiring green CI, set `evidence.require_green_ci: false`.
- To report without failing the job, set the `fail-on-block: 'false'` input. The commit status still says the PR is blocked, so don't make it a required check in this mode.
- To need fewer approvals, lower `routing.approvals`, for example `{ low: 0, medium: 0, high: 1 }`.
- On a repository with one maintainer, turn on the [owner override](#owner-override) for low-tier and medium-tier PRs.

By default, the gate checks every PR, including PRs from people. A PR without the three sections is blocked until someone adds them. Add the sections to your PR template, relax the rules above, or limit the gate to agent PRs.

### One-person repositories

The gate never waives the high tier, and the author's own approval never counts. So on a repository with one maintainer, a high-tier PR needs a review that nobody can give. When `maintainers` lists only the author, the `approvals` item says so and has `"cause": "no-other-reviewer"`. When `high_requires_codeowners` is `true` and there is no CODEOWNERS file, the `codeowners` item has `"cause": "no-codeowners-file"`. Choose one:

- Add another reviewer: a collaborator with write access, listed in `maintainers` and CODEOWNERS.
- Set `routing.approvals.high: 0` and `routing.high_requires_codeowners: false`. Evidence and green CI still apply to high-tier PRs.
- Keep the block and merge high-tier PRs with an admin bypass.

For low-tier and medium-tier PRs, use the [owner override](#owner-override).

The gate can't see who else has write access without an extra API call that the default token may not be allowed to make. So it judges by what the config names: `maintainers` and CODEOWNERS. With an empty `maintainers` list, it doesn't guess. It says that anyone with write access other than the author can approve.

### Limit the gate to agent PRs

Set `scope` to check only some PRs:

```yaml
scope:
  authors: [my-agent]   # PRs from these accounts
  bots: true            # PRs from any bot account
  labels: [agent]       # PRs with one of these labels
```

A PR is in scope when it matches any of the three. Without `scope`, every PR is in scope.

Scope never skips a high-tier PR or a PR that changes gate-control files (the config, CODEOWNERS, workflows, local actions, `action.yml` or `dist/`). The gate checks such a PR in full with the base config's rules, also with `config-ref: head`. A PR whose file list the API cut off is high tier, so it's also checked. The comment and status say why the PR is in scope, and so does `scope_note` in the JSON:

```json
"scope_note": "changes gate-control files (`.review-gate.yml`)"
```

When scope didn't force the PR in, `scope_note` is `null`.

A PR that is not in scope gets a passing `agent-pr-gate` status, so a required check doesn't wait forever. The gate doesn't comment on it. If an earlier run left a gate comment, the gate changes it to say that the PR is not in scope.

The gate always reads `scope` from the base commit, also with `config-ref: head`, so a PR can't take itself out of scope. Anyone who can edit labels can also remove one. Use `authors` and `bots` to decide who the gate checks, and use `labels` only to add more PRs.

The example workflow runs on `labeled` and `unlabeled`, so a label change re-runs the gate.

## Reference

### Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `github-token` | `github.token` | Token for API calls |
| `config-path` | `.review-gate.yml` | Config location |
| `config-ref` | `base` | Read the config from the base commit. `head` lets a PR change its own rules, so use it only on trusted repositories. CODEOWNERS always comes from the base commit |
| `ci-wait-seconds` | `0` | How long to wait for other checks to finish before judging CI. Set it to about your CI's usual duration. See [Set it up](#set-it-up) |
| `ignore-checks` | | Comma-separated extra check names to ignore |
| `status-context` | `agent-pr-gate` | Commit status to write. Empty turns the status off |
| `comment-author` | `github-actions[bot]` | Login whose marker comment the gate edits, when the token can't report its own identity. Set it when you use a GitHub App token |
| `fail-on-block` | `true` | Fail the step when the PR is blocked |
| `pr-number` | | Check this PR instead of the one in the event. `open` checks every open PR |
| `max-prs` | `20` | With `pr-number: open`, the most due PRs to check per run, oldest-checked first. Anything but a plain positive integer (`1e3`, `0x10` and `01` included) falls back to 20 with a warning |
| `recheck-max-age-hours` | `6` | With `pr-number: open`, re-check a PR at least this often, even if nothing changed |
| `min-rate-limit` | `200` | With several PRs, stop the batch when fewer core API requests remain |
| `metrics-path` | `$RUNNER_TEMP/agent-pr-gate-metrics.json` | Where to write the metrics JSON |

### Outputs

| Output | Meaning |
| --- | --- |
| `result` | `pass`, `blocked`, `out-of-scope` (see [`scope`](#limit-the-gate-to-agent-prs)), or `stale`. A stale run happens when the PR keeps changing during the check. It writes nothing, sets no status, and doesn't fail the step |
| `tier` | `low`, `medium`, or `high` |
| `required-approvals` | Approvals the tier needs |
| `approvals` | Approvals that count |
| `rounds` | Review and fix rounds so far |
| `round-cap-reached` | `true` when `rounds` reached `rounds.cap` |
| `missing` | JSON list of the codes in [Use it from an agent](#use-it-from-an-agent) |
| `comment-id` | ID of the gate comment |
| `metrics` | Metrics as JSON |
| `metrics-path` | Path of the metrics file |

### Configuration

All keys, with their defaults:

```yaml
default_tier: medium        # tier for files that no glob matches

tiers:                      # minimatch globs. A glob without a slash, like "*.md", matches at any depth.
  low: []                   # "/x" or "./x" anchors to the root. A trailing "/" means the whole directory.
  medium: []
  high: []

evidence:
  sections:                 # matched by heading, case-insensitive, punctuation ignored
    - name: Testing
      aliases: [Tests, Test plan]
    - name: Risk
      aliases: [Risks]
    - name: How to revert
      aliases: [Revert, Rollback, Revert plan, Rollback plan]
  require_green_ci: true
  ignore_checks: []         # extra check names or status contexts to leave out of the CI verdict

routing:
  approvals: { low: 0, medium: 1, high: 2 }
  high_requires_codeowners: true
  allow_stale_approvals: false                          # true: approvals on older commits count
  trusted_associations: [OWNER, MEMBER, COLLABORATOR]   # whose approvals and reviews count
  owner_override: false                                 # see "Owner override"
  owners: []                                            # empty means the repository owner
  owner_override_tiers: [low, medium]                   # high is not allowed

rounds:
  cap: 3
  review_states: [CHANGES_REQUESTED]   # add COMMENTED to count comment-only reviews

maintainers: []             # requested as reviewers when a PR reaches the round cap

scope:                      # which PRs the gate checks. Empty lists mean every PR
  authors: []
  bots: false
  labels: []

metrics:
  revert_lookback_days: 30
```

A section given as a plain string, such as `- Testing`, has no aliases.

### Tiers

Each changed file gets the highest tier whose glob matches it, else `default_tier`. A renamed file is matched on both its old and its new path. The PR gets the highest tier across its files. The gate rejects globs that can never match, such as an empty glob, `/`, a negated `!x`, a `..` segment, or a backslash, with a config error.

The files API lists at most 3000 files. If a PR changes more, the gate forces the tier to `high` and blocks the PR with `files:incomplete`, because it can't check code owners for the files it can't see.

### Evidence sections

A section starts at a markdown heading (`#` to `######`, or a setext heading) or at a bold label. A bold label is a whole line like `**Risk**` or `**Risk:**`, or a line that starts with `**Risk:**`. Bold prose such as `**Testing** was skipped.` is not a heading. A heading matches when its text equals the section name or an alias, or starts with one followed by a word. So `Risk assessment` matches `Risk`, but `Riskless` doesn't.

A section is filled by its own text, up to the next heading of any kind. Under a markdown heading, subsections that are not required sections also count, such as `### Unit` or `**Unit:** 42 passed`. A required section never fills another one.

[docs/evidence-rule.md](docs/evidence-rule.md) decides whether a line is real content. The test suite checks every worked example in that file inside every list, quote, table, bold-label, and HTML wrapper it knows.

### Green CI

Every check run (the latest per name) and every commit status on the head commit must be success, neutral, or skipped. The gate ignores its own job, its own status context, and anything in `ignore_checks`. A pending check blocks with `ci:pending`. A commit with no checks blocks with `ci:none`.

### Approvals

Each reviewer's latest decisive review counts: APPROVED, CHANGES_REQUESTED, or DISMISSED. A COMMENTED review doesn't change it. Bots and the PR author never count. An approval counts only on the current head commit, unless `allow_stale_approvals` is `true`. The reviewer's `author_association` must be in `trusted_associations`, so drive-by approvals on public repositories don't count. An empty `trusted_associations` list is a config error. The comment names stale and untrusted approvers.

### CODEOWNERS

High-tier PRs need code owner approval when `high_requires_codeowners` is `true`. The gate reads `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS` from the base commit and uses GitHub's matching rules. Every high-tier file needs an approval from one of its own owners. One owner's approval doesn't cover files that someone else owns. The gate requests owners who haven't reviewed. The comment calls out files with no owner, and files owned only by the PR author. The gate checks team owners through team membership. If that lookup fails, the comment says that branch protection must enforce the team review.

### Owner override

The owner override is for repositories with one maintainer. With `routing.owner_override: true`, a PR whose author is in `routing.owners` needs no approving review, if its tier is in `routing.owner_override_tiers`. `routing.owners` defaults to the repository owner. The comment says when the override applies, and why when it doesn't.

These limits apply whatever the config says:

- The gate never waives the high tier. Listing `high` in `owner_override_tiers` is a config error.
- The gate never waives a PR that changes a gate-control file. The list is fixed in `GATE_CONTROL_FILES` in `src/gate.ts`: `.review-gate.yml`, the configured `config-path`, `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`, `.github/workflows/**`, `.github/actions/**`, `action.yml`, and `dist/**`.
- The gate never waives code owner approval. A file owned by the author and by anyone else, including an email owner or a team, is not owned only by the author.
- Evidence, green CI, and the round cap still apply.

The override starts working once it is on the base branch.

> **Warning:** With `config-ref: head`, a PR's own `.review-gate.yml` sets its rules, so a PR can turn on the override for itself. Keep `config-ref: base` on any repository that uses the override.

### Review rounds

A round is a counted review (by default `CHANGES_REQUESTED`) that a trusted human left on a commit, after which the head moved to another commit. A trusted human is not a bot, not the PR author, and has an `author_association` in `trusted_associations`. The gate knows that the head moved when the reviewed commit is no longer the head, or when a later trusted review is on a different commit. Several reviews on one commit are one round. Pushes with no review in between add nothing. The gate uses only review commit IDs and review order, never commit dates, because the author controls those.

A dismissed review counts when the PR timeline shows that it was a change request, so dismissing a change request doesn't erase its round. If the gate can't read the timeline, and a trusted review was dismissed on a commit the PR has since moved past, it blocks with `rounds:unknown` instead of guessing. A dismissed review on the current head can't be a round, so it never causes `rounds:unknown`.

When `rounds` reaches `rounds.cap`, the comment gets a "step back" section, the PR gets the `needs-human` label, and the gate requests the maintainers. The cap doesn't change pass or fail on its own. Set `rounds.cap: 0` to turn it off.

The gate doesn't detect a force-push back to the reviewed commit with no review in between.

### Scheduled re-check

With `pr-number: open`, the gate checks open PRs as a backstop for missed events. The gate comment holds hidden state: when the gate last checked the PR, and a fingerprint of its inputs and CI verdict. A sweep checks a PR only when the gate never saw it, its fingerprint changed, its last check is older than `recheck-max-age-hours`, or the last check couldn't finish: the commit status write was refused, or review rounds couldn't be counted. It visits the oldest-checked PRs first and stops at `max-prs` due PRs. It also stops when the remaining API budget gets close to `min-rate-limit`, and it keeps budget for the checks it already planned. That budget is an estimate, scaled by the most comment pages a PR has needed so far.

The gate reads the state only from comments that its own identity wrote. Every workflow in a repository shares the default identity, `github-actions[bot]`. If other workflows post comments, run the gate with a GitHub App token and set `comment-author` to that app's bot login (for example `my-app[bot]`). Setting `comment-author` alone does not help with the default token, because the gate still posts as `github-actions[bot]`.

### Check a PR without a workflow

Where nothing reads the commit status (no branch protection, for example a private repo on GitHub Free), a merge script can ask for the verdict once, at merge time, instead of keeping the status fresh with re-runs:

```sh
GH_TOKEN=... npx github:0xgui/agent-pr-gate#<sha> check 41 --repo owner/repo
```

`check` reads what the action reads, from the same base commit, and decides the same way. It writes nothing: no comment, label, review request, or status. It prints the verdict as JSON on stdout (`result`, `tier`, `required_approvals`, `approvals`, `rounds`, `round_cap_reached`, `missing`, and each problem in full) and logs on stderr. It exits 0 when the PR passes or is not in scope, 1 when it is blocked, and 2 when it could not judge: an error, a PR that is not open, or a PR that changed while it read.

The flags mirror the inputs that affect the verdict: `--config-path`, `--config-ref`, `--ci-wait-seconds`, `--ignore-checks`, and `--status-context`. `--gate-job` (default `agent-pr-gate-job`) and `--action` (default `0xgui/agent-pr-gate`) find the gate's own job checks, so they stay out of the CI verdict as in the action. The token comes from `GH_TOKEN` or `GITHUB_TOKEN`, the repository from `--repo` or the `origin` remote. Run `check --help` for the full list.

The verdict is only as trustworthy as the machine that runs it. Use it where a local script already decides the merge, never in place of branch protection.

### Metrics

Time to first human review runs from PR creation to the first review by someone who is not a bot or the author. Reverts are commits on the default branch, and merged PRs, whose title starts with `Revert`, within `revert_lookback_days`. The gate scans the 500 most recently updated closed PRs for reverts.

## Security notes

- Use `pull_request_target`, so fork PRs get a token that can comment and add labels. That event runs the workflow from the default branch with a write token. Never check out or run PR code in the gate workflow. The action reads the PR only through the API.
- The gate reads config and CODEOWNERS from the base commit, so a PR can't lower its own tier or remove its own owners.
- The PR description is untrusted text. The action only parses it. Quote the action's outputs if you use them in `run:` steps.
- Grant only the permissions in the example: `contents: read`, `pull-requests: write`, `issues: write`, `checks: read`, `actions: read`, and `statuses: write`.
- `pull_request_review` events for fork PRs get a read-only token, so the gate can't write there. Use the review relay in `examples/review-relay.yml`, and rely on branch protection to enforce reviews.
- Before it writes, the gate re-reads the PR. If the head, base, description, draft state, or trusted reviews changed, it checks again, up to 2 more times. If they keep changing, it reports `stale` and writes nothing.
- `workflow_run` runs from the default branch with a write token, even when a fork triggered it. Never run artifacts or code from the triggering run in this workflow.
- The gate edits only marker comments that its own identity wrote, so a pasted marker can't take over the report.
- Pin this action and every other action to a full commit SHA.

## FAQ

**Why is my PR blocked when the Testing section has text?**
The text is probably a placeholder. `TODO`, `N/A`, `TBD`, a line that starts with an unchecked box (`- [ ]`), or a line like `Unit tests: TODO` counts as empty. Write what you ran and the result.

**Why doesn't my approval count?**
Approvals count only on the current head commit, from someone other than the author, with an `author_association` in `trusted_associations`. A new push makes earlier approvals stale.

**Does the gate merge or block merges itself?**
No. It writes a comment, labels, review requests, and the `agent-pr-gate` commit status. Branch protection blocks the merge, when you make that status a required check.

**The old failed job is still shown after the PR passes. Why?**
GitHub keeps the failed job from an earlier event. Use the `agent-pr-gate` commit status as the required check, because the gate updates it in place.

**Why didn't the gate @mention the maintainers?**
Editing a comment doesn't notify new mentions, so the gate requests the maintainers as reviewers instead.

**Does it work without a config file?**
Yes. Every file gets the `medium` tier, so a PR needs 1 approval, the three sections, and green CI.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) if you are an agent working on this code. Report security issues as described in [SECURITY.md](SECURITY.md). [REVIEW_POLICY.md](REVIEW_POLICY.md) describes how PRs to this repository are reviewed.

## License

[MIT](LICENSE)
