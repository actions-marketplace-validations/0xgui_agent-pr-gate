import { describe, expect, it } from 'vitest';
import { cli, CliDeps, repoFromRemote, usesAction } from '../src/cli';

const CONFIG = 'evidence:\n  sections: [Testing]\n  require_green_ci: true\nrouting:\n  approvals: { low: 0, medium: 0, high: 1 }\n';
const GATE_YML = 'on: pull_request_target\njobs:\n  agent-pr-gate-job:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: 0xgui/agent-pr-gate@abc\n';

interface Fake {
  config?: string;
  body?: string;
  state?: string;
  author?: string;
  checks?: { name: string; conclusion: string | null; suite?: number }[];
  statuses?: { context: string; state: string }[];
  failOn?: string;
}

// A fake GitHub client with the reads the gate makes. Any other method is recorded as a call the
// CLI must never make, so a write shows up in `unexpected`.
function fakeOctokit(f: Fake) {
  const unexpected: string[] = [];
  const pr = {
    number: 7,
    state: f.state ?? 'open',
    body: f.body ?? '## Testing\nnpm test: 12 passed\n',
    draft: false,
    html_url: 'https://example.test/pr/7',
    user: { login: f.author ?? 'alice', type: 'User' },
    labels: [],
    requested_reviewers: [],
    requested_teams: [],
    changed_files: 1,
    created_at: '2026-01-01T00:00:00Z',
    base: { sha: 'base-sha', ref: 'main', repo: { default_branch: 'main' } },
    head: { sha: 'head-sha' },
  };
  const content = (text: string) => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } });
  const reads: Record<string, Record<string, (p: Record<string, unknown>) => Promise<{ data: unknown }>>> = {
    pulls: {
      get: async () => ({ data: pr }),
      listFiles: async () => ({ data: [{ filename: 'src/a.ts' }] }),
      listReviews: async () => ({ data: [] }),
    },
    repos: {
      getContent: async (p) => {
        if (p.path === '.review-gate.yml') return content(f.config ?? CONFIG);
        if (p.path === '.github/workflows/gate.yml') return content(GATE_YML);
        throw Object.assign(new Error('not found'), { status: 404 });
      },
      listCommitStatusesForRef: async () => ({ data: f.statuses ?? [] }),
    },
    checks: {
      listForRef: async () => ({
        data: (f.checks ?? [{ name: 'test', conclusion: 'success' }]).map((c, i) => ({
          name: c.name,
          status: c.conclusion === null ? 'in_progress' : 'completed',
          conclusion: c.conclusion,
          details_url: `https://github.com/o/r/actions/runs/${100 + i}/job/1`,
          check_suite: { id: c.suite ?? 1 },
        })),
      }),
    },
    actions: {
      listWorkflowRunsForRepo: async () => ({ data: [{ check_suite_id: 9, path: '.github/workflows/gate.yml', event: 'pull_request_target', head_sha: 'head-sha' }] }),
    },
  };
  const rest = new Proxy(reads, {
    get: (target, ns: string) =>
      new Proxy(target[ns] ?? {}, {
        get: (methods, name: string) =>
          methods[name] ??
          (async () => {
            unexpected.push(`${ns}.${name}`);
            return { data: {} };
          }),
      }),
  });
  const octokit = {
    rest,
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, p: unknown) => {
      if (f.failOn && fn === (rest as Record<string, Record<string, unknown>>).pulls![f.failOn]) throw new Error('API down');
      return (await fn(p)).data;
    },
  };
  return { octokit: octokit as never, unexpected };
}

async function run(argv: string[], f: Fake = {}, deps: Partial<CliDeps> = {}) {
  const { octokit, unexpected } = fakeOctokit(f);
  let stdout = '';
  let stderr = '';
  const code = await cli(argv, {
    env: { GH_TOKEN: 't' },
    octokit: () => octokit,
    originUrl: () => 'git@github.com:o/r.git',
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    ...deps,
  });
  return { code, stdout, stderr, unexpected, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null };
}

describe('agent-pr-gate check', () => {
  it('passes a PR that meets every requirement, prints JSON only on stdout, and writes nothing', async () => {
    const r = await run(['check', '7']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ pr: 7, head_sha: 'head-sha', result: 'pass', tier: 'medium', required_approvals: 0, missing: [] });
    expect(r.stderr).toMatch(/Tier: medium/);
    expect(r.unexpected).toEqual([]);
  });

  it('blocks a PR with an empty required section, with exit 1 and the problems in full', async () => {
    const r = await run(['check', '7'], { body: '## Testing\nTODO\n' });
    expect(r.code).toBe(1);
    expect(r.json.result).toBe('blocked');
    expect(r.json.missing.length).toBeGreaterThan(0);
    expect(r.json.problems[0]).toMatchObject({ id: r.json.missing[0], fix: expect.any(String) });
    expect(r.unexpected).toEqual([]);
  });

  it('blocks on failing CI', async () => {
    const r = await run(['check', '7'], { checks: [{ name: 'test', conclusion: 'failure' }] });
    expect(r.code).toBe(1);
    expect(r.json.missing).toContain('ci:failing');
  });

  it('leaves the gate out of CI: its job checks (found by --action and --gate-job) and its status', async () => {
    const r = await run(['check', '7'], {
      checks: [
        { name: 'test', conclusion: 'success' },
        { name: 'agent-pr-gate-job', conclusion: 'failure', suite: 9 },
      ],
      statuses: [{ context: 'agent-pr-gate', state: 'failure' }],
    });
    expect(r.json.result).toBe('pass');
  });

  it('counts a same-name job from a workflow that does not run the action', async () => {
    const r = await run(['check', '7', '--action', 'someone/else'], {
      checks: [
        { name: 'test', conclusion: 'success' },
        { name: 'agent-pr-gate-job', conclusion: 'failure', suite: 9 },
      ],
    });
    expect(r.json.missing).toContain('ci:failing');
  });

  it('applies the high tier and its approvals from the config', async () => {
    const r = await run(['check', '7'], { config: CONFIG + 'tiers:\n  high: ["src/**"]\n' });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ tier: 'high', required_approvals: 1, approvals: 0 });
  });

  it('reports an out-of-scope PR as passing', async () => {
    const r = await run(['check', '7'], { config: 'scope:\n  authors: [agent-one]\n' });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ result: 'out-of-scope', missing: [] });
    expect(r.unexpected).toEqual([]);
  });

  it('exits 2 for a PR that is not open', async () => {
    const r = await run(['check', '7'], { state: 'closed' });
    expect(r.code).toBe(2);
    expect(r.json.result).toBe('not-open');
  });

  it('exits 2 with the reason when the API fails', async () => {
    const r = await run(['check', '7'], { failOn: 'listFiles' });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/Could not evaluate o\/r#7: API down/);
  });

  it.each([
    [[], /Usage/],
    [['check'], /Usage/],
    [['check', 'x'], /Usage/],
    [['check', '7', '8'], /Usage/],
    [['merge', '7'], /Usage/],
    [['check', '7', '--nope'], /Unknown option/],
    [['check', '7', '--ci-wait-seconds', 'soon'], /--ci-wait-seconds/],
    [['check', '7', '--repo', 'just-a-name'], /--repo must be owner\/repo/],
  ])('rejects %j with exit 2', async (argv, message) => {
    const r = await run(argv as string[]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
  });

  it('needs a token', async () => {
    const r = await run(['check', '7'], {}, { env: {} });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/GH_TOKEN/);
  });

  it('needs a repo: --repo or a GitHub origin remote', async () => {
    const r = await run(['check', '7'], {}, { originUrl: () => null });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/No --repo/);
  });

  it('prints the usage for --help', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: agent-pr-gate check <pr>/);
  });
});

describe('repoFromRemote', () => {
  it.each([
    ['https://github.com/o/r.git', 'o', 'r'],
    ['https://github.com/o/r', 'o', 'r'],
    ['git@github.com:o/r.git', 'o', 'r'],
    ['ssh://git@github.com/o/r.js.git', 'o', 'r.js'],
    ['/o/r', 'o', 'r'],
  ])('%s', (url, owner, repo) => {
    expect(repoFromRemote(url)).toEqual({ owner, repo });
  });

  it('rejects a bare name', () => {
    expect(repoFromRemote('r')).toBeNull();
  });
});

describe('usesAction', () => {
  const uses = usesAction('0xgui/agent-pr-gate');
  it.each([
    ['0xgui/agent-pr-gate@v1', true],
    ['0xGUI/Agent-PR-Gate@abc', true],
    ['0xgui/agent-pr-gate/sub@v1', true],
    ['0xgui/agent-pr-gate-fork@v1', false],
    ['actions/checkout@v4', false],
  ])('%s → %s', (ref, want) => {
    expect(uses(ref)).toBe(want);
  });
});
