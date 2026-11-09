import { minimatch } from 'minimatch';
import { GateConfig, Tier } from './config';
import { CiResult } from './ci';
import { EvidenceItem, sectionTemplate } from './evidence';
import { FileCoverage, OwnerSplit } from './codeowners';
import { RoundResult } from './reviews';
import { TierResult } from './tiers';
import { GateState, renderState } from './state';

export const MARKER = '<!-- agent-pr-gate:report -->';

/** Marker comments written by `identity` (the gate's own login), oldest first. */
export function pickGateComments<T extends { body?: string | null; user?: { login?: string } | null }>(comments: T[], identity: string): T[] {
  const me = identity.toLowerCase();
  return comments.filter((c) => (c.body ?? '').startsWith(MARKER) && (c.user?.login ?? '').toLowerCase() === me);
}

export interface CodeownersState {
  required: boolean;
  /** Union of owners of the high-tier files, used for review requests. */
  owners: OwnerSplit;
  approvedBy: string[];
  satisfied: boolean;
  /** Per high-tier file: its owners and whether one of them approved. */
  coverage?: FileCoverage[];
  requested: string[];
  note?: string;
  /** No CODEOWNERS file on the base commit. */
  missingFile?: true;
}

export interface GateInput {
  cfg: GateConfig;
  author: string;
  tier: TierResult;
  evidence: EvidenceItem[];
  ci: CiResult | null; // null when green CI is not required
  approvers: string[];
  /** Approvals that did not count: on an older commit, or from people without repo access. */
  ignoredApprovals?: { stale: string[]; untrusted: string[] };
  codeowners: CodeownersState;
  rounds: RoundResult;
  /** Set when routing.owner_override is on and the PR author is a listed owner. */
  ownerOverride?: OwnerOverride;
  /** Set when scope would skip the PR but its changes force it into scope. */
  scopeNote?: string;
  /** User login that owns the repository. Set once where the PR is read. Empty when unknown. */
  repoOwner: string;
}

export type OwnerOverride = { owner: string; applies: true } | { owner: string; applies: false; reason: string };

/**
 * Files that control the gate itself. A PR touching any of them never gets the owner override,
 * whatever the config says, because an agent opening PRs as the owner could otherwise rewrite
 * the rules or the gate's code and have its own approvals waived.
 */
export const GATE_CONTROL_FILES = ['.review-gate.yml', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.github/workflows/**', '.github/actions/**', 'action.yml', 'dist/**'];

/** Changed files (pass both sides of renames) that are gate-control files for this config. */
export function gateControlTouched(cfg: GateConfig, files: string[]): string[] {
  // config-path is a file name, not a glob: "config/gate[prod].yml" must match only itself.
  const configFile = cfg.path.replace(/^(\.\/|\/)+/, '');
  return [...new Set(files)].filter((f) => f === configFile || GATE_CONTROL_FILES.some((g) => minimatch(f, g, { dot: true })));
}

/** Undefined when the override is off or the author is not a listed owner. */
export function ownerOverrideFor(cfg: GateConfig, author: string, repoOwner: string, tier: Tier, files: string[]): OwnerOverride | undefined {
  if (!cfg.ownerOverride) return undefined;
  const owners = cfg.owners.length ? cfg.owners : [repoOwner];
  if (!owners.some((o) => o.toLowerCase() === author.toLowerCase())) return undefined;
  const no = (reason: string): OwnerOverride => ({ owner: author, applies: false, reason });
  if (tier === 'high') return no('high tier is never waived');
  if (!cfg.ownerOverrideTiers.includes(tier)) return no(`tier \`${tier}\` is not in routing.owner_override_tiers`);
  const touched = gateControlTouched(cfg, files);
  if (touched.length) return no(`the PR changes gate-control files (${touched.slice(0, 5).map((f) => '`' + f + '`').join(', ')}${touched.length > 5 ? ', ...' : ''})`);
  return { owner: author, applies: true };
}

export interface Problem {
  id: string;
  what: string;
  where: string;
  fix: string;
  /** Who can resolve it: the PR author (often an agent) or a human reviewer. */
  who: 'author' | 'reviewer';
  /** The required section, for section-missing and section-empty. */
  section?: string;
  /** Checks that failed or are still running, for ci:failing and ci:pending. */
  checks?: string[];
  /** Files that still need a code owner approval, for codeowners. */
  files?: string[];
  /** Logins and teams who can resolve it: maintainers and code owners, never the author. */
  reviewers?: string[];
  /** Why the requirement cannot be met as configured: no-other-reviewer or no-codeowners-file. */
  cause?: 'no-other-reviewer' | 'no-codeowners-file';
}

export interface GateResult {
  pass: boolean;
  tier: Tier;
  requiredApprovals: number;
  problems: Problem[];
  roundCapReached: boolean;
  waived?: string[];
}

export type SoloState = { state: 'team' } | { state: 'applied' } | { state: 'held'; reason: string };

/** People and teams named in config or CODEOWNERS, other than the author. */
export function listedOthers(cfg: GateConfig, author: string, codeowners: CodeownersState): string[] {
  const raw = [
    ...cfg.maintainers,
    ...cfg.owners,
    ...codeowners.owners.users,
    ...codeowners.owners.teams,
    ...(codeowners.coverage ?? []).flatMap((c) => c.owners),
  ];
  const me = author.toLowerCase();
  const out = new Set<string>();
  for (const item of raw) {
    const name = item.replace(/^@/, '');
    if (name.toLowerCase() !== me) out.add(name);
  }
  return [...out];
}

function sameLogin(a: string, b: string): boolean {
  return a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();
}

/** The author is named as an owner, or is the user who owns the repository. */
function authorIsListedOwner(cfg: GateConfig, author: string, codeowners: CodeownersState, repoOwner: string): boolean {
  if (repoOwner && sameLogin(author, repoOwner)) return true;
  return [...cfg.maintainers, ...cfg.owners, ...codeowners.owners.users].some((name) => sameLogin(name, author));
}

/**
 * `solo` waives high-tier reviews only when the author is the sole owner.
 * An empty owner list does not make every author the owner. `team` never waives.
 */
export function soloFor(cfg: GateConfig, author: string, codeowners: CodeownersState, repoOwner: string): SoloState {
  if (cfg.mode !== 'solo') return { state: 'team' };
  const uncovered = (codeowners.coverage ?? []).some((c) => c.status === 'no-owner' || c.status === 'team-unknown');
  if (uncovered) return { state: 'held', reason: 'a high-tier file has no confirmed owner' };
  const others = listedOthers(cfg, author, codeowners);
  if (others.length > 0) return { state: 'held', reason: `another owner is listed (${others.slice(0, 3).join(', ')})` };
  if (!authorIsListedOwner(cfg, author, codeowners, repoOwner)) return { state: 'held', reason: 'author is not a listed owner' };
  return { state: 'applied' };
}

/** Maintainers and code owners other than the author. Empty means anyone with repo access. */
function eligibleReviewers(input: GateInput): string[] {
  const all = [...input.cfg.maintainers, ...input.codeowners.owners.users, ...input.codeowners.owners.teams];
  return [...new Set(all)].filter((h) => h.toLowerCase() !== input.author.toLowerCase());
}

export function decide(input: GateInput): GateResult {
  const { cfg, tier, evidence, ci, approvers, codeowners, rounds } = input;
  const problems: Problem[] = [];
  for (const e of evidence) {
    if (e.status === 'ok') continue;
    problems.push({
      id: `section-${e.status}:${e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      section: e.name,
      what: e.status === 'missing' ? `Missing "## ${e.name}" section` : `"## ${e.name}" section is empty or only TODO`,
      where: 'PR description',
      fix:
        e.status === 'missing'
          ? `Add a "## ${e.name}" section with a result. A bare N/A does not count. Write a reason after N/A, for example \`N/A, no runtime change\`.`
          : `Replace the placeholder in "## ${e.name}". A bare N/A does not count. Write a reason after N/A, for example \`N/A, no runtime change\`. \`N/A: later\` does not count.`,
      who: 'author',
    });
  }
  if (ci) {
    if (ci.state === 'failing') {
      problems.push({ id: 'ci:failing', checks: [...ci.failing], what: `CI is failing: ${ci.failing.join(', ')}`, where: 'checks on the head commit', fix: 'Fix the failing checks and push a new commit.', who: 'author' });
    } else if (ci.state === 'pending') {
      problems.push({ id: 'ci:pending', checks: [...ci.pending], what: `CI still running: ${ci.pending.join(', ')}`, where: 'checks on the head commit', fix: 'Wait for CI to finish; the gate re-runs on the next PR event or CI completion.', who: 'author' });
    } else if (ci.state === 'none') {
      problems.push({ id: 'ci:none', what: 'No CI checks found on the head commit', where: 'checks on the head commit', fix: `Add a CI workflow, or set evidence.require_green_ci: false in ${cfg.path}.`, who: 'author' });
    }
  }
  if (tier.forced) {
    // Code owner coverage and tiers could only be checked for the listed files.
    problems.push({
      id: 'files:incomplete',
      what: 'Incomplete file list: the gate could not see every changed file',
      where: tier.forced,
      fix: 'Split the PR so it changes at most 3000 files, or have a code owner review the full diff and merge with an admin bypass.',
      who: 'reviewer',
    });
  }
  const solo = soloFor(cfg, input.author, codeowners, input.repoOwner);
  const soloHigh = solo.state === 'applied' && tier.tier === 'high';
  const need = soloHigh ? 0 : cfg.approvals[tier.tier];
  const override = input.ownerOverride?.applies === true;
  const waived: string[] = [];
  if (override && approvers.length < need) waived.push(`${need} approving review(s)`);
  if (approvers.length < need && !override) {
    const reviewers = eligibleReviewers(input);
    // Email owners cannot be requested through the API, but they are still other reviewers.
    const emailOwners = (input.codeowners.coverage ?? []).flatMap((c) => c.owners).filter((o) => !o.startsWith('@'));
    const noOther = reviewers.length === 0 && emailOwners.length === 0;
    // The cheapest correct signal: the config names reviewers (maintainers, CODEOWNERS), and the
    // author is the only one. Others with write access could still exist, so say so, not more.
    const onlyAuthor = noOther && input.cfg.maintainers.length > 0;
    const listHint = onlyAuthor
      ? ` Only the author is listed in maintainers${input.codeowners.required ? ' and CODEOWNERS' : ''}, and the author's approval never counts. If nobody else has write access, this can never pass. To fix it, add another reviewer (maintainers, CODEOWNERS and repo access), set routing.approvals.${tier.tier}: 0 in ${input.cfg.path} (evidence and CI still apply), or merge with an admin bypass.`
      : noOther
        ? ' No reviewer is listed in maintainers or CODEOWNERS, so anyone with write access other than the author can approve.'
        : '';
    problems.push({
      id: 'approvals',
      what: `Needs ${need} approving human review(s), has ${approvers.length}` + (onlyAuthor ? ' (only the author is listed as a reviewer)' : ''),
      where: 'PR reviews',
      fix:
        `${need - approvers.length} more approval(s) on the current head commit from people with repo access, other than the author. Bot approvals do not count.` +
        listHint +
        (input.ignoredApprovals?.stale.length ? ` Stale (re-approve the latest commit): ${input.ignoredApprovals.stale.map((u) => '@' + u).join(', ')}.` : '') +
        (input.ignoredApprovals?.untrusted.length ? ` Not counted (no repo access): ${input.ignoredApprovals.untrusted.map((u) => '@' + u).join(', ')}.` : ''),
      who: 'reviewer',
      reviewers,
      ...(onlyAuthor ? { cause: 'no-other-reviewer' as const } : {}),
    });
  }
  if (codeowners.required && !codeowners.satisfied && !soloHigh) {
    const who = [...codeowners.owners.users.map((u) => `@${u}`), ...codeowners.owners.teams.map((t) => `@${t}`)];
    const open = (codeowners.coverage ?? []).filter((c) => c.status !== 'approved');
    const detail = open
      .slice(0, 10)
      .map((c) =>
        c.status === 'no-owner'
          ? `${c.file} has no CODEOWNERS entry`
          : c.status === 'author-only'
            ? `${c.file} is owned only by the author (${c.owners.join(' ')})`
            : `${c.file} needs one of ${c.owners.join(' ')}`,
      );
    const notes = [codeowners.note, open.some((c) => c.status === 'author-only') ? 'The author cannot approve their own PR; add another owner or have an admin bypass.' : undefined].filter(Boolean);
    const noFile = codeowners.missingFile === true;
    problems.push({
      id: 'codeowners',
      ...(noFile ? { cause: 'no-codeowners-file' as const } : open.length > 0 && open.every((c) => c.status === 'author-only') ? { cause: 'no-other-reviewer' as const } : {}),
      what: noFile ? 'High tier needs a code owner approval, but there is no CODEOWNERS file' : 'High tier needs a code owner approval for each high-risk file',
      where: noFile ? 'No .github/CODEOWNERS, CODEOWNERS or docs/CODEOWNERS on the base branch' : detail.length ? detail.join('; ') + (open.length > 10 ? `; and ${open.length - 10} more` : '') : who.length ? `CODEOWNERS: ${who.join(', ')}` : 'CODEOWNERS',
      fix: noFile
        ? `Add a CODEOWNERS file on the base branch that names an owner other than the author, or set routing.high_requires_codeowners: false in ${input.cfg.path}.`
        : notes.length ? notes.join(' ') : `Get an approving review from an owner of each listed file.`,
      who: 'reviewer',
      files: open.map((c) => c.file),
      reviewers: [...codeowners.owners.users, ...codeowners.owners.teams].filter((h) => h.toLowerCase() !== input.author.toLowerCase()),
    });
  }
  if (rounds.unknown) {
    // Fail closed (#16): without the timeline a dismissed changes-requested review could be a
    // round, so the round cap cannot be judged. Block rather than guess.
    problems.push({
      id: 'rounds:unknown',
      what: 'Review/fix rounds could not be counted: the PR timeline could not be read',
      where: 'PR timeline (original state of dismissed reviews)',
      fix: 'Re-run the gate once the GitHub API is reachable; the token needs read access to issues and pull requests.',
      who: 'reviewer',
    });
  }
  return {
    pass: problems.length === 0,
    tier: tier.tier,
    requiredApprovals: need,
    problems,
    roundCapReached: cfg.roundCap > 0 && rounds.rounds >= cfg.roundCap,
    ...(waived.length ? { waived } : {}),
  };
}

function code(s: string): string {
  return '`' + s.replace(/`/g, "'") + '`';
}

/** A block the author cannot clear by editing the pull request. */
function maintainerOption(p: Problem, solo: SoloState, tier: Tier): string | undefined {
  if (p.cause === 'no-other-reviewer' && p.id === 'approvals') {
    return `Set \`routing.approvals.${tier}: 0\`, or set \`mode: solo\` when the author is the sole owner.`;
  }
  if (p.cause === 'no-other-reviewer' && p.id === 'codeowners') {
    return 'Set `routing.high_requires_codeowners: false`, or set `mode: solo` when the author is the sole owner.';
  }
  if (p.cause === 'no-codeowners-file') {
    return 'Add a CODEOWNERS file on the base branch, or set `routing.high_requires_codeowners: false`.';
  }
  if (solo.state === 'held' && (p.id === 'approvals' || p.id === 'codeowners')) {
    return 'Approve the pull request, or set `routing.approvals.high: 0`. `mode: solo` applies only when the author is the sole owner.';
  }
  return undefined;
}

export function renderComment(input: GateInput, result: GateResult, humans: string[], state?: GateState): string {
  const { cfg, tier, rounds } = input;
  const lines: string[] = [MARKER];
  if (state) lines.push(renderState(state));
  const head = result.pass
    ? '## ✅ agent-pr-gate: all requirements met'
    : '## ❌ agent-pr-gate: blocked';
  lines.push(head, '');
  const solo = soloFor(cfg, input.author, input.codeowners, input.repoOwner);
  const ov = input.ownerOverride;

  if (result.pass) {
    lines.push('This pull request passed.');
  } else {
    lines.push('### What is missing', '');
    const items = result.problems.map((p) => ({ p, option: maintainerOption(p, solo, tier.tier) }));
    if (result.roundCapReached) {
      items.push({
        p: {
          id: 'rounds:cap',
          what: 'Round cap reached',
          where: 'review rounds',
          fix: `This pull request has gone through ${rounds.rounds} review and fix rounds. A maintainer decides whether to continue.`,
          who: 'reviewer',
        },
        option: 'Set `rounds.cap: 0` to turn the cap off. The cap does not by itself fail the pull request.',
      });
    }
    items.forEach(({ p, option }, i) => {
      if (option) {
        lines.push(
          `${i + 1}. **${p.fix}**`,
          '   - Who: maintainer',
          '   - You cannot fix this by editing the pull request.',
          `   - Maintainer: ${option}`,
        );
      } else {
        lines.push(`${i + 1}. **${p.fix}**`, `   - Who: ${p.who}`);
      }
    });
  }

  const detail: string[] = [];
  if (input.scopeNote) detail.push(`> In scope: ${input.scopeNote}. Scope never skips high-tier or gate-control changes.`);
  if (cfg.missing) detail.push(`> No \`${cfg.path}\` on the base branch, so defaults are in use: every file gets \`${cfg.defaultTier}\`.`);
  const reqText =
    tier.tier === 'low'
      ? 'OK to merge once CI is green'
      : tier.tier === 'medium'
        ? `needs ${result.requiredApprovals} approving review(s)`
        : `needs ${result.requiredApprovals} approving review${result.requiredApprovals === 1 ? '' : 's'}${input.codeowners.required ? ' plus a CODEOWNERS approval' : ''}`;
  detail.push(`**Risk tier:** \`${tier.tier}\` (${reqText})`);
  if (tier.forced) detail.push(`**Why \`${tier.tier}\`:** ${tier.forced}`);
  if (tier.triggers.length) {
    detail.push(`**Why \`${tier.tier}\`:**`);
    for (const t of tier.triggers.slice(0, 10)) {
      detail.push(
        t.glob
          ? `- ${code(t.file)} matches ${code(t.glob)} (${cfg.path}:${t.line ?? '?'})`
          : `- ${code(t.file)} matches no tier glob, so it gets default_tier \`${cfg.defaultTier}\``,
      );
    }
    if (tier.triggers.length > 10) detail.push(`- ...and ${tier.triggers.length - 10} more`);
  }
  detail.push(`**Approvals:** ${input.approvers.length}/${result.requiredApprovals}${input.approvers.length ? ` (${input.approvers.map((a) => '@' + a).join(', ')})` : ''}${result.waived ? ' (waived)' : ''}`);
  if (solo.state === 'applied' && tier.tier === 'high') {
    detail.push('**Solo mode:** applied. The author is the sole owner, so this high-tier PR needs no other approval and no CODEOWNERS approval. Evidence and green CI still apply.');
  } else if (solo.state === 'held' && tier.tier === 'high') {
    detail.push(`**Solo mode:** not applied. ${solo.reason}. Team rules still apply.`);
  }
  if (ov?.applies && result.waived) {
    detail.push(`**Owner override:** approvals waived for repo owner @${ov.owner} (\`routing.owner_override\`): ${result.waived.join('; ')}. Evidence, CI and the round cap still apply.`);
  } else if (ov && !ov.applies && result.problems.some((p) => p.id === 'approvals')) {
    detail.push(`**Owner override:** not applied for @${ov.owner}: ${ov.reason}.`);
  }
  if (input.ci) detail.push(`**CI:** ${input.ci.state}`);
  detail.push(`**Review/fix rounds:** ${rounds.unknown ? `unknown (at least ${rounds.rounds})` : rounds.rounds}/${cfg.roundCap}`);
  if (result.roundCapReached) {
    detail.push(
      `Round cap reached after ${rounds.rounds} review and fix rounds. A maintainer decides whether to continue. Flagged for ${humans.length ? humans.map((h) => '@' + h).join(' ') : 'a maintainer'}.`,
    );
  }
  const missing = input.evidence.filter((e) => e.status !== 'ok').map((e) => e.name);
  if (missing.length) {
    const specs = cfg.sections.filter((s) => missing.includes(s.name));
    detail.push('Paste this into the PR description and replace each TODO.', '```markdown', sectionTemplate(specs), '```');
  }
  lines.push('', '<details><summary>Details</summary>', '', ...detail, '', '</details>');

  const machine = {
    schema_version: 1,
    gate: result.pass ? 'pass' : 'blocked',
    tier: result.tier,
    forced: tier.forced ?? null,
    triggers: tier.triggers.map((t) => ({ file: t.file, glob: t.glob ?? null, config_line: t.line ?? null })),
    missing: result.problems.map((p) => ({
      id: p.id,
      who: p.who,
      what: p.what,
      where: p.where,
      fix: p.fix,
      ...(p.section !== undefined ? { section: p.section } : {}),
      ...(p.checks !== undefined ? { checks: p.checks } : {}),
      ...(p.files !== undefined ? { files: p.files } : {}),
      ...(p.reviewers !== undefined ? { reviewers: p.reviewers } : {}),
      ...(p.cause !== undefined ? { cause: p.cause } : {}),
    })),
    approvals: { have: input.approvers.length, need: result.requiredApprovals },
    codeowners_required: input.codeowners.required && !(solo.state === 'applied' && tier.tier === 'high'),
    solo: solo.state,
    scope_note: input.scopeNote ?? null,
    owner_override: ov ? (ov.applies ? { owner: ov.owner, applied: true, waived: result.waived ?? [] } : { owner: ov.owner, applied: false, reason: ov.reason }) : null,
    rounds: { count: rounds.rounds, cap: cfg.roundCap, cap_reached: result.roundCapReached },
  };
  lines.push('', '<details><summary>Machine-readable result</summary>', '', '```json', JSON.stringify(machine, null, 2), '```', '', '</details>');
  return lines.join('\n');
}
