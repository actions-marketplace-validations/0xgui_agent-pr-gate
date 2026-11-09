import { describe, expect, it } from 'vitest';
import { evaluateCi } from '../src/ci';
import { ownersFor, parseCodeowners, splitOwners } from '../src/codeowners';
import { parseConfig, DEFAULT_SECTIONS } from '../src/config';
import { checkEvidence } from '../src/evidence';
import { decide, GateInput, MARKER, renderComment } from '../src/gate';
import { classify } from '../src/tiers';
import { isRevertTitle } from '../src/metrics';

describe('CI evaluation', () => {
  it('ignores the gate own check by name and by run id', () => {
    const r = evaluateCi(
      [
        { name: 'test', status: 'completed', conclusion: 'success' },
        { name: 'agent-pr-gate', status: 'completed', conclusion: 'failure' },
        { name: 'other-job', status: 'in_progress', conclusion: null, url: 'https://github.com/o/r/actions/runs/42/job/1' },
      ],
      [{ context: 'agent-pr-gate', state: 'failure' }],
      { names: ['agent-pr-gate'], runId: '42' },
    );
    expect(r).toMatchObject({ state: 'green', passed: ['test'] });
  });

  it('reports failing, pending and none', () => {
    expect(evaluateCi([{ name: 'a', status: 'completed', conclusion: 'failure' }], [], { names: [] }).state).toBe('failing');
    expect(evaluateCi([{ name: 'a', status: 'queued', conclusion: null }], [], { names: [] }).state).toBe('pending');
    expect(evaluateCi([], [], { names: [] }).state).toBe('none');
  });

  it('uses only the newest status per context', () => {
    const r = evaluateCi([], [{ context: 'ext', state: 'success' }, { context: 'ext', state: 'failure' }], { names: [] });
    expect(r.state).toBe('green');
  });
});

describe('CODEOWNERS', () => {
  const rules = parseCodeowners('# comment\n* @org/all\n/.github/ @alice\ncharts/ @bob @org/infra\n*.md docs@example.com\n');
  it('uses the last matching rule', () => {
    expect(ownersFor('.github/workflows/ci.yml', rules)).toEqual(['@alice']);
    expect(ownersFor('deploy/charts/x/values.yaml', rules)).toEqual(['@bob', '@org/infra']);
    expect(ownersFor('src/a.ts', rules)).toEqual(['@org/all']);
  });
  it('splits users and teams and drops emails', () => {
    expect(splitOwners(['@bob', '@org/infra', 'docs@example.com'])).toEqual({ users: ['bob'], teams: ['org/infra'] });
  });
});

describe('gate decision and comment', () => {
  const cfg = parseConfig('tiers:\n  low: ["docs/**"]\n  high: [".github/workflows/**"]\nmaintainers: ["@lead"]\n');
  const base = (over: Partial<GateInput>): GateInput => ({
    cfg,
    author: 'agent',
    tier: classify(['docs/a.md'], cfg),
    evidence: checkEvidence('## Testing\nok\n## Risk\nok\n## How to revert\nok', DEFAULT_SECTIONS),
    ci: { state: 'green', failing: [], pending: [], passed: ['test'] },
    approvers: [],
    codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
    rounds: { rounds: 0, openedBy: [] },
    repoOwner: 'lead',
    ...over,
  });

  it('F2: the JSON verdict has a schema version, what and where, and the reviewers needed', () => {
    const mcfg = parseConfig('maintainers: ["@lead", "@agent"]\n');
    const input = base({
      cfg: mcfg,
      tier: classify(['src/a.ts'], mcfg),
      evidence: checkEvidence('## Testing\nTODO\n## Risk\nok\n', DEFAULT_SECTIONS),
    });
    const r = decide(input);
    expect(r.problems.map((p) => p.id)).toEqual(['section-empty:testing', 'section-missing:how-to-revert', 'approvals']);
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(renderComment(input, r, ['lead']))![1]!);
    expect(json.schema_version).toBe(1);
    expect(json.missing[0]).toMatchObject({ id: 'section-empty:testing', who: 'author', section: 'Testing', where: 'PR description' });
    expect(json.missing[0].what).toMatch(/Testing/);
    expect(json.missing[1]).toMatchObject({ id: 'section-missing:how-to-revert', section: 'How to revert' });
    expect(json.missing[2]).toMatchObject({ id: 'approvals', who: 'reviewer', reviewers: ['lead'] });
  });
  it('F2: codes use one separator style (kind or kind:detail)', () => {
    const ci = (state: 'failing' | 'pending' | 'none') => decide(base({ ci: { state, failing: ['test'], pending: ['lint'], passed: [] } })).problems[0]!;
    expect(ci('failing')).toMatchObject({ id: 'ci:failing', checks: ['test'] });
    expect(ci('pending')).toMatchObject({ id: 'ci:pending', checks: ['lint'] });
    expect(decide(base({ rounds: { rounds: 0, openedBy: [], unknown: true } })).problems.map((p) => p.id)).toEqual(['rounds:unknown']);
  });
  it('#16: blocks with a clear reason when rounds could not be counted', () => {
    const input = base({ approvers: ['lead'], rounds: { rounds: 0, openedBy: [], unknown: true } });
    const r = decide(input);
    expect(r.pass).toBe(false);
    expect(r.problems.map((p) => p.id)).toEqual(['rounds:unknown']);
    expect(r.problems[0]!.what).toMatch(/timeline/i);
    expect(renderComment(input, r, [])).toMatch(/Review\/fix rounds:\*\* unknown/);
  });
  it('passes a low-tier PR with evidence and green CI and no approvals', () => {
    const input = base({});
    const res = decide(input);
    expect(res.pass).toBe(true);
    const body = renderComment(input, res, []);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('all requirements met');
  });

  it('blocks a high-tier PR and points at the file and config line', () => {
    const input = base({
      tier: classify(['.github/workflows/ci.yml', 'docs/a.md'], cfg),
      evidence: checkEvidence('## Testing\nran it', DEFAULT_SECTIONS),
      approvers: ['alice'],
      codeowners: { required: true, owners: { users: ['lead'], teams: [] }, approvedBy: [], satisfied: false, requested: [] },
    });
    const res = decide(input);
    expect(res.pass).toBe(false);
    expect(res.problems.map((p) => p.id)).toEqual(['section-missing:risk', 'section-missing:how-to-revert', 'approvals', 'codeowners']);
    const body = renderComment(input, res, ['lead']);
    expect(body).toContain('`.github/workflows/ci.yml` matches `.github/workflows/**` (.review-gate.yml:3)');
    expect(body).toContain('```markdown\n## Risk');
    expect(body).not.toContain('## Testing\nTODO');
    expect(body).toContain('"gate": "blocked"');
  });

  it('flags the round cap for a human', () => {
    const input = base({ rounds: { rounds: 3, openedBy: [] } });
    const res = decide(input);
    expect(res.roundCapReached).toBe(true);
    expect(renderComment(input, res, ['lead'])).toContain('Round cap reached');
  });

  it('blocks on pending or missing CI', () => {
    expect(decide(base({ ci: { state: 'pending', failing: [], pending: ['test'], passed: [] } })).problems[0]?.id).toBe('ci:pending');
    expect(decide(base({ ci: { state: 'none', failing: [], pending: [], passed: [] } })).problems[0]?.id).toBe('ci:none');
  });
});

describe('revert detection', () => {
  it('matches titles that start with Revert', () => {
    expect(isRevertTitle('Revert "Add thing"')).toBe(true);
    expect(isRevertTitle('revert: bad deploy')).toBe(true);
    expect(isRevertTitle('Add revert button')).toBe(false);
  });
});

describe('missing config notice', () => {
  it('tells the reader defaults are in use', () => {
    const cfg = { ...parseConfig(''), missing: true };
    const input: GateInput = {
      cfg,
      author: 'agent',
      tier: classify(['a.txt'], cfg),
      evidence: checkEvidence('', DEFAULT_SECTIONS),
      ci: null,
      approvers: [],
      codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
      rounds: { rounds: 0, openedBy: [] },
      repoOwner: 'agent',
    };
    expect(renderComment(input, decide(input), [])).toContain('No `.review-gate.yml` on the base branch');
  });
});

describe('scope note', () => {
  it('says why a PR was forced into scope', () => {
    const cfg = parseConfig('');
    const input: GateInput = {
      cfg,
      author: 'alice',
      tier: classify(['.review-gate.yml'], cfg),
      evidence: checkEvidence('## Testing\nok\n## Risk\nok\n## How to revert\nok', DEFAULT_SECTIONS),
      ci: null,
      approvers: [],
      codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
      rounds: { rounds: 0, openedBy: [] },
      repoOwner: 'alice',
      scopeNote: 'changes gate-control files (`.review-gate.yml`)',
    };
    const body = renderComment(input, decide(input), []);
    expect(body).toMatch(/In scope: changes gate-control files/);
    expect(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)![1]!).scope_note).toMatch(/gate-control/);
  });
});

describe('solo maintainer: requirements that no one but the author can meet', () => {
  const evidence = checkEvidence('## Testing\nok\n## Risk\nok\n## How to revert\nok', DEFAULT_SECTIONS);
  const noOwners = { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] };
  const mk = (yml: string, over: Partial<GateInput> = {}): GateInput => {
    const cfg = parseConfig(yml);
    return { cfg, author: 'solo', tier: classify(['.github/workflows/ci.yml'], cfg), evidence, ci: null, approvers: [], codeowners: noOwners, rounds: { rounds: 0, openedBy: [] }, repoOwner: 'solo', ...over };
  };
  const json = (input: GateInput) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(renderComment(input, decide(input), []))![1]!);

  it('says the approvals can never come when only the author is listed, with fix steps', () => {
    const input = mk('tiers:\n  high: [".github/workflows/**"]\nrouting:\n  approvals: { high: 1 }\n  high_requires_codeowners: false\nmaintainers: ["@solo"]\n');
    const p = decide(input).problems.find((x) => x.id === 'approvals')!;
    expect(p.cause).toBe('no-other-reviewer');
    expect(p.fix).toMatch(/routing\.approvals\.high: 0/);
    expect(p.fix).toMatch(/admin bypass/);
    expect(p.fix).toMatch(/CODEOWNERS|maintainers/);
    expect(json(input).missing[0]).toMatchObject({ id: 'approvals', cause: 'no-other-reviewer', reviewers: [] });
    expect(renderComment(input, decide(input), [])).toMatch(/only the author/i);
  });

  it('keeps the plain message when nobody is listed, and says what an empty reviewers list means', () => {
    const input = mk('tiers:\n  high: [".github/workflows/**"]\nrouting:\n  high_requires_codeowners: false\n');
    const p = decide(input).problems.find((x) => x.id === 'approvals')!;
    expect(p.cause).toBeUndefined();
    expect(p.fix).toMatch(/No reviewer is listed/);
  });

  it('names a missing CODEOWNERS file as the cause', () => {
    const input = mk('tiers:\n  high: [".github/workflows/**"]\nrouting:\n  approvals: { high: 0 }\n', {
      codeowners: { ...noOwners, required: true, satisfied: false, missingFile: true },
    });
    const p = decide(input).problems.find((x) => x.id === 'codeowners')!;
    expect(p.cause).toBe('no-codeowners-file');
    expect(p.what).toMatch(/no CODEOWNERS file/);
    expect(p.fix).toMatch(/high_requires_codeowners: false/);
    expect(json(input).missing[0].cause).toBe('no-codeowners-file');
  });

  it('marks files owned only by the author with the same cause', () => {
    const input = mk('tiers:\n  high: [".github/workflows/**"]\nrouting:\n  approvals: { high: 0 }\n', {
      codeowners: { ...noOwners, required: true, satisfied: false, owners: { users: ['solo'], teams: [] }, coverage: [{ file: '.github/workflows/ci.yml', owners: ['@solo'], status: 'author-only', approvedBy: [] }] },
    });
    expect(decide(input).problems.find((x) => x.id === 'codeowners')!.cause).toBe('no-other-reviewer');
  });

  it('does not say no-other-reviewer when an email co-owner owns the file with the author (#3)', () => {
    const input = mk('tiers:\n  high: [".github/workflows/**"]\nrouting:\n  approvals: { high: 1 }\nmaintainers: ["@solo"]\n', {
      codeowners: { ...noOwners, required: true, satisfied: false, owners: { users: ['solo'], teams: [] }, coverage: [{ file: '.github/workflows/ci.yml', owners: ['@solo', 'co@example.com'], status: 'pending', approvedBy: [] }] },
    });
    const p = decide(input).problems.find((x) => x.id === 'approvals')!;
    expect(p.cause).toBeUndefined();
    expect(p.what).not.toMatch(/only the author/i);
    expect(p.fix).not.toMatch(/Only the author is listed|No reviewer is listed/);
  });

  it('writes "1 approving review" in the tier line', () => {
    const input = mk('tiers:\n  high: [".github/workflows/**"]\nrouting:\n  approvals: { high: 1 }\n  high_requires_codeowners: false\n');
    expect(renderComment(input, decide(input), [])).toMatch(/needs 1 approving review\)/);
  });
});
