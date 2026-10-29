import { parseArgs } from 'node:util';
import { judgePr, Judgement, Octokit, Repo, Settings } from './evaluate';
import { ciWaitFor } from './writes';

/**
 * `agent-pr-gate check <pr>`: the gate's verdict for one PR as JSON, without a workflow run.
 * Read-only: it writes no comment, label, review request or status. Its verdict is only as
 * trustworthy as the machine that runs it, so it suits a local merge script, not branch protection.
 */

export const USAGE = `Usage: agent-pr-gate check <pr> [options]

Prints agent-pr-gate's verdict for a pull request as JSON. Reads only: writes no comment, label or status.
Exit code: 0 pass or not in scope, 1 blocked, 2 could not judge (error, PR not open, or PR changed meanwhile).

Options:
  --repo <owner/repo>       Repository. Default: the origin remote of the current directory.
  --config-path <path>      Gate config. Default: .review-gate.yml
  --config-ref <base|head>  Where rules come from. Default: base
  --ci-wait-seconds <n>     Wait this long for CI to finish before judging. Default: 0
  --ignore-checks <a,b>     Extra check names or status contexts to leave out of the CI verdict.
  --status-context <name>   The gate's commit status, left out of the CI verdict. Default: agent-pr-gate
  --gate-job <id>           The gate's job ID in your workflows, left out of CI. Default: agent-pr-gate-job
  --action <owner/repo>     The action your workflows use, to find the gate's job. Default: 0xgui/agent-pr-gate

Token: GH_TOKEN or GITHUB_TOKEN. API: GITHUB_API_URL (default https://api.github.com).
`;

export interface CliDeps {
  env: Record<string, string | undefined>;
  octokit: (token: string) => Octokit;
  /** The origin remote URL, or null when there is none. */
  originUrl: () => string | null;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** owner/repo from a GitHub remote URL (https or ssh), or null. */
export function repoFromRemote(url: string): Repo | null {
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** True for a step `uses:` that is `action` (owner/repo), pinned or a path inside it. */
export function usesAction(action: string): (ref: string) => boolean {
  const a = action.trim().toLowerCase();
  return (ref) => {
    const u = ref.trim().toLowerCase();
    return u.startsWith(`${a}@`) || u.startsWith(`${a}/`);
  };
}

/** The JSON the CLI prints: the action's outputs, plus each problem in full. */
export function verdictJson(prNumber: number, judged: Judgement): Record<string, unknown> {
  switch (judged.kind) {
    case 'out-of-scope':
      return { pr: prNumber, head_sha: judged.pr.head.sha, result: 'out-of-scope', reason: judged.reason, missing: [] };
    case 'not-open':
      return { pr: prNumber, result: 'not-open', missing: [] };
    case 'stale':
      return { pr: prNumber, result: 'stale', reason: judged.reason, missing: [] };
    case 'evaluated': {
      const { ev } = judged;
      return {
        pr: prNumber,
        head_sha: ev.pr.head.sha,
        result: ev.result.pass ? 'pass' : 'blocked',
        tier: ev.result.tier,
        required_approvals: ev.result.requiredApprovals,
        approvals: ev.input.approvers.length,
        rounds: ev.input.rounds.rounds,
        round_cap_reached: ev.result.roundCapReached,
        missing: ev.result.problems.map((p) => p.id),
        problems: ev.result.problems,
      };
    }
  }
}

/** Runs the CLI; returns the exit code. */
export async function cli(argv: string[], deps: CliDeps): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        'config-path': { type: 'string', default: '.review-gate.yml' },
        'config-ref': { type: 'string', default: 'base' },
        'ci-wait-seconds': { type: 'string', default: '0' },
        'ignore-checks': { type: 'string', default: '' },
        'status-context': { type: 'string', default: 'agent-pr-gate' },
        'gate-job': { type: 'string', default: 'agent-pr-gate-job' },
        action: { type: 'string', default: '0xgui/agent-pr-gate' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    deps.stderr(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: o, positionals } = args;
  if (o.help) {
    deps.stdout(USAGE);
    return 0;
  }
  const [command, prArg, ...extra] = positionals;
  const prNumber = Number(prArg);
  if (command !== 'check' || !Number.isInteger(prNumber) || prNumber <= 0 || extra.length) {
    deps.stderr(USAGE);
    return 2;
  }
  const wait = Number(o['ci-wait-seconds']);
  if (!Number.isFinite(wait) || wait < 0) {
    deps.stderr(`--ci-wait-seconds must be a number of seconds; got "${o['ci-wait-seconds']}".\n`);
    return 2;
  }
  const token = deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN;
  if (!token) {
    deps.stderr('Set GH_TOKEN or GITHUB_TOKEN to a token that can read the repository.\n');
    return 2;
  }
  const remote = o.repo ? null : deps.originUrl();
  const repo = o.repo ? repoFromRemote(`/${o.repo}`) : remote ? repoFromRemote(remote) : null;
  if (!repo) {
    deps.stderr(o.repo ? `--repo must be owner/repo; got "${o.repo}".\n` : 'No --repo given and no GitHub origin remote here.\n');
    return 2;
  }

  const statusContext = o['status-context'];
  const settings: Settings = {
    configPath: o['config-path'],
    configRef: o['config-ref'],
    ignoreChecks: [
      ...o['ignore-checks'].split(',').map((s) => s.trim()).filter(Boolean),
      ...(statusContext ? [statusContext] : []),
    ],
    job: o['gate-job'],
    usesThisAction: usesAction(o.action),
    log: { info: (m) => deps.stderr(`${m}\n`), warning: (m) => deps.stderr(`warning: ${m}\n`) },
  };
  let judged: Judgement;
  try {
    judged = await judgePr(deps.octokit(token), repo, settings, prNumber, ciWaitFor(wait));
  } catch (e) {
    deps.stderr(`Could not evaluate ${repo.owner}/${repo.repo}#${prNumber}: ${(e as Error).message}\n`);
    return 2;
  }
  const out = verdictJson(prNumber, judged);
  deps.stdout(JSON.stringify(out, null, 2) + '\n');
  if (out.result === 'pass' || out.result === 'out-of-scope') return 0;
  return out.result === 'blocked' ? 1 : 2;
}
