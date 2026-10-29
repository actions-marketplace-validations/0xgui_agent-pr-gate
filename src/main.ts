import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tier, TIERS } from './config';
import { inScope, renderOutOfScope } from './scope';
import { timeToFirstHumanReview } from './reviews';
import { pickGateComments, renderComment } from './gate';
import { isRevertTitle, Metrics, metricsMarkdown } from './metrics';
import { ciWaitFor, Outcome, stateAfterStatus, statusState, statusWriteNeeded, stepShouldFail, tryWrite } from './writes';
import { fingerprint, GateState, parseState } from './state';
import { onceByKey, positiveInt, sweepReserve, planSweep, rateLimitLow, runEach, SweepCandidate } from './sweep';
import {
  ciIgnores,
  configFor,
  Evaluation,
  isNotFound,
  judgePr,
  listReviews,
  Octokit,
  readCi,
  Repo,
  scopeConfigFor,
  scopePr,
  ScopeLike,
  Settings,
  toInputs,
} from './evaluate';

const LABEL_COLORS: Record<string, string> = {
  'risk:low': '0e8a16',
  'risk:medium': 'fbca04',
  'risk:high': 'b60205',
  'needs-human': '5319e7',
};

async function resolvePrNumbers(octokit: Octokit, repo: Repo): Promise<number[]> {
  const input = core.getInput('pr-number').trim();
  if (input) {
    const nums = input.split(',').map((x) => Number(x.trim()));
    if (nums.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`pr-number must be a PR number, a comma-separated list, or "open"; got "${input}"`);
    return nums;
  }
  const p = github.context.payload as Record<string, unknown> & {
    pull_request?: { number: number };
    workflow_run?: { pull_requests?: { number: number }[]; head_sha?: string };
    check_suite?: { pull_requests?: { number: number }[]; head_sha?: string };
  };
  if (p.pull_request?.number) return [p.pull_request.number];
  const suite = p.workflow_run ?? p.check_suite;
  if (suite) {
    const nums = (suite.pull_requests ?? []).map((x) => x.number);
    if (nums.length) return nums;
    if (suite.head_sha) {
      const res = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: suite.head_sha });
      const found = res.data.filter((pr) => pr.state === 'open').map((pr) => pr.number);
      if (found.length) return found;
      // Fork PRs are not always returned above; match open PRs by head SHA instead.
      const open = await octokit.paginate(octokit.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
      return open.filter((pr) => pr.head.sha === suite.head_sha).map((pr) => pr.number);
    }
  }
  return [];
}

async function ensureLabel(octokit: Octokit, repo: Repo, name: string): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ ...repo, name });
  } catch (e) {
    if (!isNotFound(e)) throw e;
    try {
      await octokit.rest.issues.createLabel({ ...repo, name, color: LABEL_COLORS[name] ?? 'ededed', description: 'Set by agent-pr-gate' });
    } catch (err) {
      // 422 means another run created it in the meantime.
      if ((err as { status?: number }).status !== 422) throw err;
    }
  }
}

async function setRiskLabel(octokit: Octokit, repo: Repo, pr: number, current: string[], tier: Tier): Promise<void> {
  const want = `risk:${tier}`;
  for (const t of TIERS) {
    const name = `risk:${t}`;
    if (name !== want && current.includes(name)) {
      await octokit.rest.issues.removeLabel({ ...repo, issue_number: pr, name }).catch((e) => {
        if (!isNotFound(e)) throw e;
      });
    }
  }
  if (!current.includes(want)) {
    await ensureLabel(octokit, repo, want);
    await octokit.rest.issues.addLabels({ ...repo, issue_number: pr, labels: [want] });
  }
}

/** Login the gate posts as: the token's own user for PATs, else the comment-author input. */
async function commentIdentity(octokit: Octokit): Promise<string> {
  const configured = core.getInput('comment-author') || 'github-actions[bot]';
  try {
    // Works for user tokens. The default GITHUB_TOKEN gets a 403 here.
    const me = await octokit.rest.users.getAuthenticated();
    return me.data.login;
  } catch {
    return configured;
  }
}

type GateComment = { id: number; body?: string | null };

async function gateComments(octokit: Octokit, repo: Repo, pr: number): Promise<GateComment[]> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...repo, issue_number: pr, per_page: 100 });
  const identity = (await commentIdentity(octokit)).toLowerCase();
  // Only adopt marker comments the gate itself wrote. Anyone can paste the marker.
  return pickGateComments(comments, identity);
}

/** `listed` skips the read when the caller already has the gate's comments. */
async function upsertComment(octokit: Octokit, repo: Repo, pr: number, body: string, listed?: GateComment[]): Promise<{ id: number; created: boolean }> {
  const mine = listed ?? (await gateComments(octokit, repo, pr));
  if (mine.length > 0) {
    const target = mine[0]!;
    if (target.body !== body) await octokit.rest.issues.updateComment({ ...repo, comment_id: target.id, body });
    else core.info('Gate comment already up to date.');
    if (mine.length > 1) core.warning(`Found ${mine.length} gate comments; updated the oldest (${target.id}).`);
    return { id: target.id, created: false };
  }
  const res = await octokit.rest.issues.createComment({ ...repo, issue_number: pr, body });
  return { id: res.data.id, created: true };
}

/**
 * The action's inputs and workflow context as evaluation settings. Read at call time, per PR.
 * ignoreChecks holds the check names and status contexts that are the gate itself; the job's own
 * checks are found by workflow in readCi (#2).
 */
function actionSettings(): Settings {
  const statusContext = core.getInput('status-context');
  return {
    configPath: core.getInput('config-path') || '.review-gate.yml',
    configRef: core.getInput('config-ref'),
    ignoreChecks: [
      ...core.getInput('ignore-checks').split(',').map((s) => s.trim()).filter(Boolean),
      ...(statusContext ? [statusContext] : []),
    ],
    job: github.context.job,
    runId: String(github.context.runId),
    usesThisAction,
    log: { info: (m) => core.info(m), warning: (m) => core.warning(m) },
  };
}

/** True for a step `uses:` that is this action: owner/repo@ref, or ./ in the action's own repo. */
function usesThisAction(ref: string): boolean {
  const u = ref.trim().toLowerCase();
  const action = (process.env.GITHUB_ACTION_REPOSITORY ?? '').toLowerCase();
  if (action && (u.startsWith(`${action}@`) || u.startsWith(`${action}/`))) return true;
  const here = `${github.context.repo.owner}/${github.context.repo.repo}`.toLowerCase();
  return (u === './' || u === '.') && (!action || action === here);
}

async function requestReviews(
  octokit: Octokit,
  repo: Repo,
  pr: number,
  users: string[],
  teams: string[],
  skip: Set<string>,
): Promise<string[]> {
  const u = users.filter((x) => !skip.has(x.toLowerCase()));
  const t = teams.map((x) => x.split('/')[1]!).filter((x) => !skip.has(x.toLowerCase()));
  if (!u.length && !t.length) return [];
  try {
    await octokit.rest.pulls.requestReviewers({ ...repo, pull_number: pr, reviewers: u, team_reviewers: t });
    return [...u, ...t];
  } catch (e) {
    core.warning(`Could not request reviewers ${[...u, ...t].join(', ')}: ${(e as Error).message}`);
    return [];
  }
}

async function collectReverts(octokit: Octokit, repo: Repo, defaultBranch: string, days: number): Promise<Metrics['reverts']> {
  const since = new Date(Date.now() - days * 86400_000);
  const commits = await octokit.paginate(octokit.rest.repos.listCommits, { ...repo, sha: defaultBranch, since: since.toISOString(), per_page: 100 });
  const revert_commits = commits
    .map((c) => ({ sha: c.sha, title: c.commit.message.split('\n')[0] ?? '', date: c.commit.committer?.date ?? '' }))
    .filter((c) => isRevertTitle(c.title));
  const revert_prs: Metrics['reverts']['revert_prs'] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await octokit.rest.pulls.list({ ...repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100, page });
    for (const p of res.data) {
      if (p.merged_at && Date.parse(p.merged_at) >= since.getTime() && isRevertTitle(p.title)) {
        revert_prs.push({ number: p.number, title: p.title, merged_at: p.merged_at });
      }
    }
    const last = res.data[res.data.length - 1];
    if (res.data.length < 100 || !last || Date.parse(last.updated_at) < since.getTime()) break;
  }
  return { lookback_days: days, revert_commits, revert_prs };
}

/** Latest status for a context on a commit. Pages (newest first) until the context is found. */
async function latestStatus(octokit: Octokit, repo: Repo, sha: string, context: string): Promise<{ state: string; description: string | null; updated_at: string } | null> {
  for await (const page of octokit.paginate.iterator(octokit.rest.repos.listCommitStatusesForRef, { ...repo, ref: sha, per_page: 100 })) {
    const s = page.data.find((x) => x.context === context);
    if (s) return { state: s.state, description: s.description ?? null, updated_at: s.updated_at };
  }
  return null;
}

let revertCache: ((key: string) => Promise<Metrics['reverts']>) | null = null;
/** Reverts depend only on the repo, so a sweep over many PRs looks them up once. */
function revertsOnce(octokit: Octokit, repo: Repo): (key: string) => Promise<Metrics['reverts']> {
  revertCache ??= onceByKey((key) => {
    const [branch, days] = key.split('\n');
    return collectReverts(octokit, repo, branch!, Number(days));
  });
  return revertCache;
}

/**
 * An out-of-scope PR gets a passing status, so required-status setups do not wait forever. The
 * gate creates no comment, so PRs it does not own get no noise. If an earlier run left a gate
 * comment, it is rewritten to say the PR is not in scope, so it never shows an old verdict.
 */
async function writeOutOfScope(octokit: Octokit, repo: Repo, pr: ScopeLike & { number: number; html_url: string }, reason: string): Promise<Outcome> {
  const log = { warning: (m: string) => core.warning(m) };
  core.info(`PR #${pr.number}: ${reason}. Not checked.`);
  await tryWrite(
    'marking the gate comment as not in scope',
    async () => {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...repo, issue_number: pr.number, per_page: 100 });
      const mine = pickGateComments(comments, await commentIdentity(octokit));
      const body = renderOutOfScope(reason);
      if (mine.length && mine[0]!.body !== body) await octokit.rest.issues.updateComment({ ...repo, comment_id: mine[0]!.id, body });
    },
    log,
  );
  const statusContext = core.getInput('status-context');
  if (statusContext) {
    const want = { state: 'success', description: 'not in scope' };
    if (statusWriteNeeded(await latestStatus(octokit, repo, pr.head.sha, statusContext), want)) {
      await tryWrite(
        'setting the commit status (needs statuses: write)',
        () => octokit.rest.repos.createCommitStatus({ ...repo, sha: pr.head.sha, state: 'success', context: statusContext, description: want.description, target_url: pr.html_url }),
        log,
        [403, 404, 422],
      );
    }
  }
  core.setOutput('result', 'out-of-scope');
  core.setOutput('tier', '');
  core.setOutput('missing', '[]');
  return 'pass';
}

/** Fingerprint of a PR's inputs plus its CI, computed exactly as evaluatePr stores it (#11). */
async function currentFingerprint(octokit: Octokit, repo: Repo, prNumber: number): Promise<string> {
  const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
  const s = actionSettings();
  const cfg = await configFor(octokit, repo, s, pr);
  const reviews = await listReviews(octokit, repo, prNumber);
  const ci = await readCi(octokit, repo, s, pr.head.sha, pr.base.repo.default_branch, ciIgnores(cfg, s));
  return fingerprint(toInputs(pr, reviews, { author: pr.user?.login ?? '', trustedAssociations: cfg.trustedAssociations }), ci);
}

async function storedState(octokit: Octokit, repo: Repo, prNumber: number, identity: string): Promise<{ state: GateState | null; pages: number }> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...repo, issue_number: prNumber, per_page: 100 });
  const mine = pickGateComments(comments, identity);
  return { state: mine.length ? parseState(mine[0]!.body) : null, pages: Math.max(1, Math.ceil(comments.length / 100)) };
}

/** Null while the budget, after `reserve` calls kept for evaluations, stays above min-rate-limit. */
async function rateGuard(octokit: Octokit, reserve = 0): Promise<string | null> {
  const minRemaining = Number(core.getInput('min-rate-limit') || '200');
  const rl = await octokit.rest.rateLimit.get();
  const remaining = rl.data.resources.core.remaining;
  if (!rateLimitLow(remaining, minRemaining, reserve)) return null;
  return `API rate limit low (${remaining} left, min-rate-limit ${minRemaining}` + (reserve ? `, ${reserve} reserved for evaluations)` : ')');
}

/**
 * Plan a scheduled sweep. Reads the gate's stored state from each open PR's comment (one call
 * per PR, guarded and fault-tolerant), then computes fingerprints oldest-evaluated first and
 * stops once max-prs due PRs are found.
 */
async function planOpenSweep(octokit: Octokit, repo: Repo): Promise<number[]> {
  const rawMaxPrs = core.getInput('max-prs');
  const maxPrs = positiveInt(rawMaxPrs, 20);
  if (rawMaxPrs.trim() && String(maxPrs) !== rawMaxPrs.trim()) core.warning(`max-prs "${rawMaxPrs}" is not a positive integer; using 20.`);
  const maxAgeMs = Number(core.getInput('recheck-max-age-hours') || '6') * 3600_000;
  const listed = await octokit.paginate(octokit.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
  // Out-of-scope PRs never get a state marker, so they would always look due. Skip them unless
  // they have state, which only a full gate writes: then a high-tier or gate-control change forced
  // them into scope, and they keep being re-checked. Skipping writes nothing. Only runForPr posts
  // the out-of-scope pass, and it checks for those changes first.
  // One config read per base commit. If it fails, keep the PR (fail safe: check it).
  const settings = actionSettings();
  const scopeByBase = onceByKey((sha: string) => scopeConfigFor(octokit, repo, settings, { base: { sha }, head: { sha } }));
  const outOfScope = new Set<number>();
  for (const pr of listed) {
    try {
      if (!inScope((await scopeByBase(pr.base.sha)).scope, scopePr(pr)).inScope) outOfScope.add(pr.number);
    } catch {
      // keep it in scope
    }
  }
  const open = listed;
  const identity = await commentIdentity(octokit);
  const cands: SweepCandidate[] = [];
  let read = 0;
  let skipped = 0;
  // Busy PRs need more than one page per read. Reserve for the most pages seen so far (#34).
  let pages = 1;
  for (const pr of open) {
    // Keep enough budget for this state read, a fingerprint of every PR found so far plus this
    // one, and their evaluations up to max-prs (#13, #28).
    const found = cands.length + 1;
    const stop = await rateGuard(octokit, sweepReserve({ stateReads: 1, fingerprints: found, evaluations: Math.min(maxPrs, found), pages }));
    if (stop) {
      core.notice(`Sweep planning stopped early: ${stop}. Read state for ${read} of ${open.length} PR(s).`);
      break;
    }
    try {
      const { state: stored, pages: used } = await storedState(octokit, repo, pr.number, identity);
      read++;
      pages = Math.max(pages, used);
      if (stored === null && outOfScope.has(pr.number)) {
        skipped++;
        continue;
      }
      cands.push({ number: pr.number, stored });
    } catch (e) {
      core.warning(`Sweep: could not read the gate comment on #${pr.number}: ${(e as Error).message}`);
    }
  }
  if (skipped) core.info(`Sweep: skipped ${skipped} open PR(s) that are not in scope.`);
  const plan = await planSweep(
    cands,
    (n) => currentFingerprint(octokit, repo, n),
    { maxPrs, maxAgeMs, now: new Date() },
    // Fingerprint only while the budget still covers evaluating one more PR on top of those planned.
    (planned) => rateGuard(octokit, sweepReserve({ fingerprints: 1, evaluations: planned + 1 })),
    (n, e) => core.warning(`Sweep: could not fingerprint #${n}: ${(e as Error).message}`),
  );
  core.info(
    `Sweep: ${open.length} open PR(s); running ${plan.run.length} (${plan.run.join(', ') || 'none'}), ` +
      `skipping ${plan.skipped.length} unchanged, deferring ${plan.deferred.length}, failed ${plan.failed.length}` +
      (plan.stoppedEarly ? `, stopped early: ${plan.stoppedEarly}` : '') +
      '.',
  );
  return plan.run;
}

/** Write the verdict: labels, review requests, the comment (with stored state) and the status. */
async function writeEvaluation(octokit: Octokit, repo: Repo, ev: Evaluation): Promise<Outcome> {
  const { pr, cfg, author, input, result, humans, reviews, alreadyAsked } = ev;
  const prNumber = pr.number;
  const tier = input.tier;
  const codeowners = input.codeowners;
  const statusContext = core.getInput('status-context');
  const log = { warning: (m: string) => core.warning(m) };

  // Writes. Each one is non-fatal on 403/404 so a read-only token still yields a verdict.
  const labels = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  await tryWrite(`setting the risk:${tier.tier} label`, () => setRiskLabel(octokit, repo, prNumber, labels, tier.tier), log);
  if (codeowners.required && !codeowners.satisfied) {
    codeowners.requested =
      (await tryWrite('requesting code owner reviews', () => requestReviews(octokit, repo, prNumber, codeowners.owners.users, codeowners.owners.teams, alreadyAsked), log)) ?? [];
    codeowners.requested.forEach((x) => alreadyAsked.add(x.toLowerCase()));
  }
  if (result.roundCapReached) {
    await tryWrite(
      'adding the needs-human label',
      async () => {
        await ensureLabel(octokit, repo, 'needs-human');
        await octokit.rest.issues.addLabels({ ...repo, issue_number: prNumber, labels: ['needs-human'] });
      },
      log,
    );
    // Editing a comment does not notify new @mentions, so also request review from maintainers.
    await tryWrite('requesting maintainer reviews', () => requestReviews(octokit, repo, prNumber, cfg.maintainers, [], alreadyAsked), log);
  }

  const state: GateState = { v: 1, evaluatedAt: new Date().toISOString(), fingerprint: ev.fingerprint };
  // Write the status first, so the comment and its state marker are written once (#27).
  const listed = await gateComments(octokit, repo, prNumber).catch(() => undefined);
  const link = listed?.[0] ? `${pr.html_url}#issuecomment-${listed[0].id}` : pr.html_url;

  let statusInPlace = true;
  if (statusContext) {
    const forced = input.scopeNote ? ` (in scope: ${input.scopeNote.split(' (')[0]})` : '';
    const desc = ((result.pass ? `risk:${tier.tier}, all requirements met` : `risk:${tier.tier}, ${result.problems.length} requirement(s) missing`) + forced).slice(0, 140);
    const want = { state: statusState(result.pass ? 'pass' : 'blocked')!, description: desc };
    const latest = await latestStatus(octokit, repo, pr.head.sha, statusContext);
    if (!statusWriteNeeded(latest, want)) {
      core.info(`Commit status "${statusContext}" already ${want.state} with the same description; not writing another.`);
    } else {
      statusInPlace = null !== (await tryWrite(
        'setting the commit status (needs statuses: write)',
        () =>
          octokit.rest.repos.createCommitStatus({
            ...repo,
            sha: pr.head.sha,
            state: want.state,
            context: statusContext,
            description: desc,
            target_url: link,
          }),
        log,
        [403, 404, 422],
      ));
    }
  }
  // A missing or stale status, or unknown rounds, keep the PR due for the next sweep (#12, #27, #32).
  const body = renderComment(input, result, humans, stateAfterStatus(state, statusInPlace, input.rounds.unknown === true));
  const comment = await tryWrite('writing the gate comment', () => upsertComment(octokit, repo, prNumber, body, listed), log);
  if (comment) core.info(`${comment.created ? 'Created' : 'Updated'} gate comment ${comment.id}`);

  const reverts = await revertsOnce(octokit, repo)(`${pr.base.repo.default_branch}\n${cfg.revertLookbackDays}`);
  const ttfr = timeToFirstHumanReview(pr.created_at, reviews, author);
  const approvers = input.approvers;
  const metrics: Metrics = {
    pr: prNumber,
    tier: tier.tier,
    gate: result.pass ? 'pass' : 'blocked',
    time_to_first_human_review_seconds: ttfr === null ? null : Math.round(ttfr / 1000),
    human_approvals: approvers.length,
    human_approvers: approvers,
    rounds: input.rounds.rounds,
    reverts,
    generated_at: new Date().toISOString(),
  };
  const metricsPath = core.getInput('metrics-path') || path.join(process.env.RUNNER_TEMP ?? '.', 'agent-pr-gate-metrics.json');
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2) + '\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading(`agent-pr-gate: PR #${prNumber} ${result.pass ? 'passed' : 'blocked'}`, 2)
      .addRaw(metricsMarkdown(metrics) + '\n\n')
      .addRaw(result.problems.length ? result.problems.map((p) => `- ${p.what}`).join('\n') + '\n' : 'Nothing missing.\n')
      .write();
  }

  core.setOutput('result', result.pass ? 'pass' : 'blocked');
  core.setOutput('tier', tier.tier);
  core.setOutput('required-approvals', String(result.requiredApprovals));
  core.setOutput('approvals', String(approvers.length));
  core.setOutput('rounds', String(input.rounds.rounds));
  core.setOutput('round-cap-reached', String(result.roundCapReached));
  core.setOutput('missing', JSON.stringify(result.problems.map((p) => p.id)));
  core.setOutput('comment-id', comment ? String(comment.id) : '');
  core.setOutput('metrics', JSON.stringify(metrics));
  core.setOutput('metrics-path', metricsPath);

  if (!result.pass) core.info(`Blocked: ${result.problems.map((p) => p.id).join(', ')}`);
  return result.pass ? 'pass' : 'blocked';
}

export async function runForPr(octokit: Octokit, repo: Repo, prNumber: number): Promise<Outcome> {
  const wait = ciWaitFor(Number(core.getInput('ci-wait-seconds') || '0'));
  const judged = await judgePr(octokit, repo, actionSettings(), prNumber, wait);
  switch (judged.kind) {
    case 'out-of-scope':
      return writeOutOfScope(octokit, repo, judged.pr, judged.reason);
    case 'not-open':
      core.info(`PR #${prNumber} is not open; nothing to gate.`);
      return 'stale';
    case 'stale':
      // Neutral: no label, comment or commit status, and the step does not fail or claim a pass.
      core.notice(`Stale run for PR #${prNumber}: ${judged.reason}. Nothing written; the next event or scheduled re-check will report.`);
      core.setOutput('result', 'stale');
      return 'stale';
    case 'evaluated':
      if (judged.attempts > 1) core.info(`PR #${prNumber} inputs settled after ${judged.attempts} evaluations.`);
      return writeEvaluation(octokit, repo, judged.ev);
  }
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);
    const repo = github.context.repo;
    const sweep = core.getInput('pr-number').trim() === 'open';
    const prs = sweep
      ? await planOpenSweep(octokit, repo)
      : await resolvePrNumbers(octokit, repo);
    if (prs.length === 0) {
      core.info(sweep ? 'Sweep: nothing to re-check.' : `No pull request found for event "${github.context.eventName}"; nothing to do.`);
      return;
    }
    const { outcomes } = await runEach(
      prs,
      (n) => runForPr(octokit, repo, n),
      { error: (m) => core.error(m), notice: (m) => core.notice(m) },
      prs.length > 1 ? () => rateGuard(octokit) : undefined,
    );
    const all = [...outcomes.values()];
    const errors = [...outcomes.entries()].filter(([, o]) => o === 'error').map(([n]) => `#${n}`);
    if (errors.length) core.setFailed(`agent-pr-gate: could not evaluate ${errors.join(', ')}. See the log.`);
    else if (stepShouldFail(all, core.getInput('fail-on-block') !== 'false')) {
      core.setFailed('agent-pr-gate: requirements not met. See the gate comment on the PR.');
    }
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : String(e));
  }
}
