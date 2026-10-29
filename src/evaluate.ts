import type * as github from '@actions/github';
import { configRefs, defaultConfig, GateConfig, parseConfig, Tier } from './config';
import { forcedIntoScope, inScope, ScopePr } from './scope';
import { classify } from './tiers';
import { checkEvidence } from './evidence';
import { evaluateCi, CiResult, gateSuites, GateLookup, WorkflowRunLite } from './ci';
import { codeownerCoverage, parseCodeowners, ownersFor, splitOwners } from './codeowners';
import { approvalsFor, countRounds, isBotLogin, ReviewLite } from './reviews';
import { CodeownersState, decide, GateInput, ownerOverrideFor } from './gate';
import { evaluateUntilStable } from './writes';
import { fingerprint, inputsKey, PrInputs, toPrInputs } from './state';

/**
 * The read-only half of the gate: read a PR and decide. No writes. The action (main.ts) and the
 * CLI (cli.ts) both call judgePr; only the action writes the comment, labels and status.
 */

export type Octokit = ReturnType<typeof github.getOctokit>;
export interface Repo {
  owner: string;
  repo: string;
}
export type PullRequest = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];

export interface Log {
  info(message: string): void;
  warning(message: string): void;
}

/** What the caller decides instead of the action inputs and the workflow context. */
export interface Settings {
  /** Path of the gate config in the repo (config-path). */
  configPath: string;
  /** Where rules come from: "base" (default) or "head" (config-ref). */
  configRef: string;
  /** Check names and status contexts that are the gate itself: ignore-checks plus status-context. */
  ignoreChecks: string[];
  /** The gate's job ID. Its own check runs are found by workflow, see readCi (#2). */
  job: string;
  /** The workflow run evaluating now, whose checks are the gate's own. Unset outside Actions. */
  runId?: string;
  /** True for a step `uses:` that is this action. */
  usesThisAction: (ref: string) => boolean;
  log: Log;
}

export function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: number }).status === 404;
}

export async function readFile(octokit: Octokit, repo: Repo, filePath: string, ref: string): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ ...repo, path: filePath, ref });
    const data = res.data as { type?: string; content?: string; encoding?: string };
    if (data.type !== 'file' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, (data.encoding as BufferEncoding) || 'base64').toString('utf8');
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Per-process caches for finding the gate's own checks (#2): runs per head SHA, files per path and ref. */
const runsBySha = new Map<string, Promise<WorkflowRunLite[]>>();
const workflowFiles = new Map<string, Promise<string | null>>();
let gateLookupWarned = false;

function gateLookup(octokit: Octokit, repo: Repo): GateLookup {
  return {
    runs: (sha, refresh) => {
      if (refresh || !runsBySha.has(sha)) {
        const p = octokit
          .paginate(octokit.rest.actions.listWorkflowRunsForRepo, { ...repo, head_sha: sha, per_page: 100 })
          .then((runs) => runs.map((r) => ({ checkSuiteId: r.check_suite_id ?? 0, path: r.path ?? '', event: r.event, headSha: r.head_sha })));
        runsBySha.set(sha, p);
        p.catch(() => runsBySha.delete(sha));
      }
      return runsBySha.get(sha)!;
    },
    workflow: (path, ref) => {
      const key = `${path}@${ref}`;
      if (!workflowFiles.has(key)) {
        const p = readFile(octokit, repo, path, ref);
        workflowFiles.set(key, p);
        p.catch(() => workflowFiles.delete(key));
      }
      return workflowFiles.get(key)!;
    },
  };
}

export async function readCi(octokit: Octokit, repo: Repo, s: Settings, sha: string, defaultBranch: string, ignoreNames: string[]): Promise<CiResult> {
  const checks = await octokit.paginate(octokit.rest.checks.listForRef, { ...repo, ref: sha, per_page: 100, filter: 'latest' });
  const statuses = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, { ...repo, ref: sha, per_page: 100 });
  const lite = checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.details_url ?? c.html_url, suiteId: c.check_suite?.id ?? null }));
  const { job, runId } = s;
  let suites: number[] | undefined;
  try {
    suites = await gateSuites(lite, { job, runId }, sha, defaultBranch, s.usesThisAction, gateLookup(octokit, repo));
  } catch (e) {
    // Without actions: read the workflow runs can't be read; fall back to skipping by job name.
    if (!gateLookupWarned) s.log.warning(`Could not map checks to workflow runs (${(e as Error).message}); skipping every check named "${job}". Grant actions: read to fix this.`);
    gateLookupWarned = true;
  }
  return evaluateCi(lite, statuses.map((st) => ({ context: st.context, state: st.state })), { names: ignoreNames, runId, job, gateSuites: suites });
}

async function waitForCi(octokit: Octokit, repo: Repo, s: Settings, sha: string, defaultBranch: string, ignoreNames: string[], waitSeconds: number): Promise<CiResult> {
  const deadline = Date.now() + waitSeconds * 1000;
  let ci = await readCi(octokit, repo, s, sha, defaultBranch, ignoreNames);
  while ((ci.state === 'pending' || ci.state === 'none') && Date.now() < deadline) {
    s.log.info(`CI is ${ci.state}; waiting (pending: ${ci.pending.join(', ') || 'none yet'})`);
    await new Promise((r) => setTimeout(r, 15000));
    ci = await readCi(octokit, repo, s, sha, defaultBranch, ignoreNames);
  }
  return ci;
}

/**
 * Original state of each dismissed review, from the timeline's review_dismissed events.
 * The reviews API only reports DISMISSED; dismissed_review.state keeps what it was.
 */
async function dismissedOriginalStates(octokit: Octokit, repo: Repo, s: Settings, pr: number): Promise<Map<number, string> | null> {
  const out = new Map<number, string>();
  try {
    const events = await octokit.paginate(octokit.rest.issues.listEventsForTimeline, { ...repo, issue_number: pr, per_page: 100 });
    for (const e of events as { event?: string; dismissed_review?: { review_id?: number; state?: string } }[]) {
      if (e.event === 'review_dismissed' && e.dismissed_review?.review_id && e.dismissed_review.state) {
        out.set(e.dismissed_review.review_id, e.dismissed_review.state);
      }
    }
  } catch (err) {
    // Fail closed (#16): countRounds reports rounds as unknown and the gate blocks.
    s.log.warning(`Could not read the PR timeline: ${(err as Error).message}. Rounds are unknown; the gate blocks.`);
    return null;
  }
  return out;
}

async function loadConfig(octokit: Octokit, repo: Repo, s: Settings, ref: string): Promise<GateConfig> {
  const text = await readFile(octokit, repo, s.configPath, ref);
  if (text === null) {
    s.log.warning(`${s.configPath} not found at ${ref}; using defaults (every file gets the default tier).`);
    return { ...defaultConfig(s.configPath), missing: true };
  }
  return parseConfig(text, s.configPath);
}

async function codeownersState(
  octokit: Octokit,
  repo: Repo,
  cfg: GateConfig,
  tier: Tier,
  highFiles: string[],
  baseSha: string,
  approvers: string[],
  author: string,
): Promise<CodeownersState> {
  const empty: CodeownersState = { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] };
  if (tier !== 'high' || !cfg.highRequiresCodeowners) return empty;
  let text: string | null = null;
  for (const p of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    text = await readFile(octokit, repo, p, baseSha);
    if (text !== null) break;
  }
  if (text === null) {
    return { ...empty, required: true, satisfied: false, missingFile: true, note: `No CODEOWNERS file on the base branch. Add one, or set routing.high_requires_codeowners: false in ${cfg.path}.` };
  }
  const rules = parseCodeowners(text);
  const owners = splitOwners([...new Set(highFiles.flatMap((f) => ownersFor(f, rules)))]);

  // Resolve team membership for each approver up front. A 404 can mean "not a member" or
  // "this token cannot see the team", so it is reported as unknown, never as a silent no.
  const membership = new Map<string, boolean | null>();
  let teamNote: string | undefined;
  for (const team of owners.teams) {
    const [org, slug] = team.split('/');
    for (const a of approvers) {
      let v: boolean | null;
      try {
        const m = await octokit.rest.teams.getMembershipForUserInOrg({ org: org!, team_slug: slug!, username: a });
        v = m.data.state === 'active';
      } catch {
        v = null;
      }
      if (v === null) teamNote = `Could not confirm membership of @${team} with this token (404 or no org access). Branch protection must enforce the team review.`;
      membership.set(`${team}\n${a.toLowerCase()}`, v);
    }
  }
  if (owners.teams.length && approvers.length === 0) {
    teamNote = `Team owners (${owners.teams.map((t) => '@' + t).join(', ')}) can only be verified when this token can read org teams. Otherwise branch protection must enforce the team review.`;
  }
  const coverage = codeownerCoverage(highFiles, rules, approvers, author, (team, user) => membership.get(`${team}\n${user.toLowerCase()}`) ?? null);
  const satisfied = coverage.length > 0 && coverage.every((c) => c.status === 'approved');
  const approvedBy = [...new Set(coverage.flatMap((c) => c.approvedBy))].sort();
  return { required: true, owners, approvedBy, satisfied, coverage, requested: [], note: satisfied ? undefined : teamNote };
}

export interface PrLike {
  head: { sha: string };
  base: { sha: string };
  body?: string | null;
  draft?: boolean;
}

export type Who = { author: string; trustedAssociations: string[] };

export function toInputs(pr: PrLike, reviews: ReviewLite[], who: Who): PrInputs {
  return toPrInputs({ headSha: pr.head.sha, baseSha: pr.base.sha, body: pr.body ?? null, draft: Boolean(pr.draft) }, reviews, who);
}

/** The repo config that applies to a PR (base by default, head with config-ref: head). */
export function configFor(octokit: Octokit, repo: Repo, s: Settings, pr: PrLike): Promise<GateConfig> {
  return loadConfig(octokit, repo, s, configRefs(s.configRef, pr).rules);
}

export interface ScopeLike extends PrLike {
  user?: { login?: string; type?: string } | null;
  labels?: ({ name?: string } | string)[];
}

export function scopePr(pr: ScopeLike): ScopePr {
  const login = pr.user?.login ?? '';
  return { author: login, isBot: isBotLogin(login, pr.user?.type), labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))) };
}

/** Scope always comes from the base commit's config, so a PR cannot take itself out of scope. */
export function scopeConfigFor(octokit: Octokit, repo: Repo, s: Settings, pr: PrLike): Promise<GateConfig> {
  return loadConfig(octokit, repo, s, configRefs(s.configRef, pr).scope);
}

/** One ignore list for the CI verdict and the fingerprint, so both describe the same CI (#11). */
export function ciIgnores(cfg: GateConfig, s: Settings): string[] {
  return [...cfg.ignoreChecks, ...s.ignoreChecks];
}

export async function listReviews(octokit: Octokit, repo: Repo, prNumber: number): Promise<ReviewLite[]> {
  const raw = await octokit.paginate(octokit.rest.pulls.listReviews, { ...repo, pull_number: prNumber, per_page: 100 });
  return raw.map((r) => ({
    id: r.id,
    user: r.user?.login ?? '',
    isBot: isBotLogin(r.user?.login ?? '', r.user?.type),
    state: r.state,
    submittedAt: r.submitted_at ?? null,
    commitId: r.commit_id ?? null,
    association: r.author_association,
  }));
}

/** Current inputs key of an open PR, or null when it is no longer open. */
async function currentInputsKey(octokit: Octokit, repo: Repo, prNumber: number, who: Who): Promise<string | null> {
  const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (pr.state !== 'open') return null;
  return inputsKey(toInputs(pr, await listReviews(octokit, repo, prNumber), who));
}

export interface Evaluation {
  pr: PullRequest;
  cfg: GateConfig;
  author: string;
  input: GateInput;
  result: ReturnType<typeof decide>;
  humans: string[];
  reviews: ReviewLite[];
  alreadyAsked: Set<string>;
  inputsKey: string;
  fingerprint: string;
}

/** Read everything and decide. No writes. Returns null when the PR is not open. */
export async function evaluatePr(octokit: Octokit, repo: Repo, s: Settings, prNumber: number, ciWaitSeconds: number, scopeNote?: string): Promise<Evaluation | null> {
  const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (pr.state !== 'open') return null;
  const author = pr.user?.login ?? '';
  // A PR forced into scope could otherwise relax its own rules with config-ref: head (#39).
  const cfg = scopeNote ? await scopeConfigFor(octokit, repo, s, pr) : await configFor(octokit, repo, s, pr);

  const fileObjs = await octokit.paginate(octokit.rest.pulls.listFiles, { ...repo, pull_number: prNumber, per_page: 100 });
  const files = fileObjs.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  // The files API stops at 3000 entries. Unseen files could be high risk.
  const tier = classify(files, cfg, { total: pr.changed_files, seen: fileObjs.length });
  s.log.info(`Tier: ${tier.tier} (${tier.triggers.map((t) => t.file).join(', ') || 'default'})`);

  const evidence = checkEvidence(pr.body, cfg.sections);
  const reviews = await listReviews(octokit, repo, prNumber);
  const approval = approvalsFor(reviews, author, {
    headSha: pr.head.sha,
    allowStale: cfg.allowStaleApprovals,
    trustedAssociations: cfg.trustedAssociations,
  });
  const approvers = approval.approvers;
  const rounds = countRounds(reviews, {
    headSha: pr.head.sha,
    dismissedOriginal: reviews.some((r) => r.state === 'DISMISSED') ? await dismissedOriginalStates(octokit, repo, s, prNumber) : new Map(),
    author,
    states: cfg.roundReviewStates,
    trustedAssociations: cfg.trustedAssociations,
  });

  // Code owners are required per high-tier file. If the tier was forced (file list truncated),
  // every listed file needs its owner.
  const highFiles = tier.forced ? [...new Set(files)] : tier.triggers.map((t) => t.file);
  const codeowners = await codeownersState(octokit, repo, cfg, tier.tier, highFiles, pr.base.sha, approvers, author);
  const alreadyAsked = new Set<string>([
    author.toLowerCase(),
    ...reviews.map((r) => r.user.toLowerCase()),
    ...(pr.requested_reviewers ?? []).map((r) => r.login.toLowerCase()),
    ...(pr.requested_teams ?? []).map((t) => t.slug.toLowerCase()),
  ]);

  // One CI snapshot for the verdict and the fingerprint (#11).
  const snapshot = cfg.requireGreenCi
    ? await waitForCi(octokit, repo, s, pr.head.sha, pr.base.repo.default_branch, ciIgnores(cfg, s), ciWaitSeconds)
    : await readCi(octokit, repo, s, pr.head.sha, pr.base.repo.default_branch, ciIgnores(cfg, s));
  const ci: CiResult | null = cfg.requireGreenCi ? snapshot : null;

  const input: GateInput = {
    cfg,
    author,
    tier,
    ...(scopeNote ? { scopeNote } : {}),
    evidence,
    ci,
    approvers,
    ignoredApprovals: { stale: approval.stale, untrusted: approval.untrusted },
    codeowners,
    rounds,
    ownerOverride: ownerOverrideFor(cfg, author, repo.owner, tier.tier, files),
  };
  if (input.ownerOverride) s.log.info(input.ownerOverride.applies ? `Owner override applies to @${author}.` : `Owner override not applied for @${author}: ${input.ownerOverride.reason}.`);
  const result = decide(input);
  const humans = [...new Set([...cfg.maintainers, ...codeowners.owners.users, ...codeowners.owners.teams])].filter(
    (h) => h.toLowerCase() !== author.toLowerCase(),
  );
  const prInputs = toInputs(pr, reviews, { author, trustedAssociations: cfg.trustedAssociations });
  return { pr, cfg, author, input, result, humans, reviews, alreadyAsked, inputsKey: inputsKey(prInputs), fingerprint: fingerprint(prInputs, snapshot) };
}

export type Judgement =
  | { kind: 'out-of-scope'; pr: PullRequest; reason: string }
  | { kind: 'not-open' }
  | { kind: 'stale'; reason: string }
  | { kind: 'evaluated'; ev: Evaluation; attempts: number };

/**
 * Scope first, then a full evaluation that only counts if the PR did not change meanwhile.
 * `ciWait(attempt)` is how long that attempt waits for CI. Reads only.
 */
export async function judgePr(octokit: Octokit, repo: Repo, s: Settings, prNumber: number, ciWait: (attempt: number) => number): Promise<Judgement> {
  const { data: current } = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
  let scopeNote: string | undefined;
  if (current.state === 'open') {
    const scopeCfg = await scopeConfigFor(octokit, repo, s, current);
    const scope = inScope(scopeCfg.scope, scopePr(current));
    if (!scope.inScope) {
      // Scope never skips high-tier or gate-control changes. Judge them with the base config,
      // which the PR cannot change, and gate the PR in full when either applies.
      const fileObjs = await octokit.paginate(octokit.rest.pulls.listFiles, { ...repo, pull_number: prNumber, per_page: 100 });
      const forced = forcedIntoScope(scopeCfg, fileObjs, current.changed_files);
      if (!forced) return { kind: 'out-of-scope', pr: current, reason: scope.reason };
      scopeNote = forced;
      s.log.info(`PR #${prNumber} is in scope: ${forced}.`);
    }
  }
  const stable = await evaluateUntilStable(
    // Only the first attempt waits for CI; retries re-read it once (#14).
    (attempt) => evaluatePr(octokit, repo, s, prNumber, ciWait(attempt), scopeNote),
    (ev) => ev.inputsKey,
    (ev) => currentInputsKey(octokit, repo, prNumber, { author: ev.author, trustedAssociations: ev.cfg.trustedAssociations }),
    2,
  );
  if (stable === null) return { kind: 'not-open' };
  if (stable.stale) return { kind: 'stale', reason: stable.reason };
  return { kind: 'evaluated', ev: stable.value, attempts: stable.attempts };
}
