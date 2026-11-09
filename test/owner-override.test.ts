// Owner override: a listed owner's own low or medium PR needs no approving review. High tier and
// PRs that touch gate-control files are never waived. Evidence, CI and the round cap still apply.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeownerCoverage, parseCodeowners } from '../src/codeowners';
import { ConfigError, DEFAULT_SECTIONS, parseConfig } from '../src/config';
import { checkEvidence } from '../src/evidence';
import { decide, GATE_CONTROL_FILES, GateInput, ownerOverrideFor, renderComment } from '../src/gate';
import { classify } from '../src/tiers';

const ON = 'tiers:\n  low: ["docs/**"]\n  medium: ["src/**"]\n  high: ["deploy/**"]\nrouting:\n  owner_override: true\n';
const GOOD = '## Testing\n42 passed\n## Risk\nlow\n## How to revert\ngit revert';

function input(cfgText: string, files: string[], over: Partial<GateInput> = {}, repoOwner = 'owner'): GateInput {
  const cfg = parseConfig(cfgText);
  const author = over.author ?? 'owner';
  const tier = classify(files, cfg);
  return {
    cfg,
    author,
    tier,
    evidence: checkEvidence(GOOD, DEFAULT_SECTIONS),
    ci: { state: 'green', failing: [], pending: [], passed: ['test'] },
    approvers: [],
    codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
    rounds: { rounds: 0, openedBy: [] },
    ownerOverride: ownerOverrideFor(cfg, author, repoOwner, tier.tier, files),
    repoOwner,
    ...over,
  };
}
const ids = (i: GateInput) => decide(i).problems.map((p) => p.id);

describe('config', () => {
  it('is off by default and limited to low and medium', () => {
    const cfg = parseConfig('');
    expect(cfg.ownerOverride).toBe(false);
    expect(cfg.owners).toEqual([]);
    expect(cfg.ownerOverrideTiers).toEqual(['low', 'medium']);
  });
  it('parses owners and owner_override_tiers', () => {
    const cfg = parseConfig('routing:\n  owner_override: true\n  owners: ["@0xgui"]\n  owner_override_tiers: [low]\n');
    expect(cfg.owners).toEqual(['0xgui']);
    expect(cfg.ownerOverrideTiers).toEqual(['low']);
  });
  it('rejects high, unknown tiers and a non-boolean switch', () => {
    expect(() => parseConfig('routing:\n  owner_override_tiers: [low, high]\n')).toThrow(ConfigError);
    expect(() => parseConfig('routing:\n  owner_override_tiers: [urgent]\n')).toThrow(ConfigError);
    expect(() => parseConfig('routing:\n  owner_override: yes please\n')).toThrow(ConfigError);
  });
  it("this repo's .review-gate.yml enables the override for 0xgui with the default tiers", () => {
    const cfg = parseConfig(readFileSync('.review-gate.yml', 'utf8'));
    expect(cfg.ownerOverride).toBe(true);
    expect(cfg.owners).toEqual(['0xgui']);
    expect(cfg.ownerOverrideTiers).toEqual(['low', 'medium']);
    expect(cfg.approvals).toEqual({ low: 0, medium: 1, high: 2 });
  });
});

describe('who and what it applies to', () => {
  it('applies to the repo owner when owners is empty, case-insensitively, and to nobody else', () => {
    const cfg = parseConfig(ON);
    expect(ownerOverrideFor(cfg, 'Owner', 'owner', 'medium', ['src/a.ts'])).toEqual({ owner: 'Owner', applies: true });
    expect(ownerOverrideFor(cfg, 'agent', 'owner', 'medium', ['src/a.ts'])).toBeUndefined();
  });
  it('with owners listed, applies only to them', () => {
    const cfg = parseConfig(ON + '  owners: [lead]\n');
    expect(ownerOverrideFor(cfg, 'lead', 'org', 'medium', ['src/a.ts'])?.applies).toBe(true);
    expect(ownerOverrideFor(cfg, 'org', 'org', 'medium', ['src/a.ts'])).toBeUndefined();
  });
  it('never applies when disabled', () => {
    expect(ownerOverrideFor(parseConfig('routing:\n  owners: [owner]\n'), 'owner', 'owner', 'low', ['docs/a.md'])).toBeUndefined();
  });
  it.each(GATE_CONTROL_FILES.map((g) => g.replace('**', 'x.yml')))('never applies when the PR touches %s', (file) => {
    const ov = ownerOverrideFor(parseConfig(ON), 'owner', 'owner', 'medium', ['src/a.ts', file]);
    expect(ov).toMatchObject({ applies: false });
  });
  it('treats a custom config path as a gate-control file too', () => {
    const cfg = parseConfig(ON, 'config/gate.yml');
    expect(ownerOverrideFor(cfg, 'owner', 'owner', 'medium', ['config/gate.yml'])).toMatchObject({ applies: false });
  });
  it('respects a narrower owner_override_tiers', () => {
    const cfg = parseConfig(ON + '  owner_override_tiers: [low]\n');
    expect(ownerOverrideFor(cfg, 'owner', 'owner', 'medium', ['src/a.ts'])).toMatchObject({ applies: false });
    expect(ownerOverrideFor(cfg, 'owner', 'owner', 'low', ['docs/a.md'])).toMatchObject({ applies: true });
  });
});

describe('decision', () => {
  it("waives approvals on the owner's medium PR and says so", () => {
    const i = input(ON, ['src/a.ts']);
    const res = decide(i);
    expect(res.pass).toBe(true);
    expect(res.waived).toEqual(['1 approving review(s)']);
    expect(renderComment(i, res, [])).toContain('**Owner override:** approvals waived for repo owner @owner');
  });
  it("waives approvals on the owner's low PR when low needs one", () => {
    const res = decide(input(ON + '  approvals: { low: 1 }\n', ['docs/a.md']));
    expect(res.pass).toBe(true);
    expect(res.waived).toEqual(['1 approving review(s)']);
  });
  it('does not waive the high tier, and the comment says why', () => {
    const i = input(ON, ['deploy/prod.yml']);
    expect(i.tier.tier).toBe('high');
    expect(ids(i)).toEqual(['approvals']);
    expect(renderComment(i, decide(i), [])).toContain('**Owner override:** not applied for @owner: high tier is never waived.');
  });
  it('does not waive a medium PR that touches a gate-control file', () => {
    const i = input('tiers:\n  medium: ["src/**", "dist/**"]\nrouting:\n  owner_override: true\n', ['src/a.ts', 'dist/index.js']);
    expect(i.tier.tier).toBe('medium');
    expect(ids(i)).toEqual(['approvals']);
    expect(renderComment(i, decide(i), [])).toContain('not applied for @owner: the PR changes gate-control files (`dist/index.js`)');
  });
  it('still blocks the same PR from a non-owner', () => {
    expect(ids(input(ON, ['src/a.ts'], { author: 'agent' }))).toEqual(['approvals']);
  });
  it('never drops a code owner problem', () => {
    const i = input(ON, ['src/a.ts'], { codeowners: { required: true, owners: { users: ['owner'], teams: [] }, approvedBy: [], satisfied: false, coverage: [{ file: 'src/a.ts', owners: ['@owner'], approvedBy: [], status: 'author-only' }], requested: [] } });
    expect(ids(i)).toEqual(['codeowners']);
  });
  it('evidence, CI and the round cap still apply', () => {
    expect(ids(input(ON, ['src/a.ts'], { evidence: checkEvidence('## Testing\nTODO add tests later\n## Risk\nlow\n## How to revert\nrevert', DEFAULT_SECTIONS) }))).toEqual(['section-empty:testing']);
    expect(ids(input(ON, ['src/a.ts'], { ci: { state: 'failing', failing: ['test'], pending: [], passed: [] } }))).toEqual(['ci:failing']);
    expect(decide(input(ON, ['src/a.ts'], { rounds: { rounds: 3, openedBy: [] } })).roundCapReached).toBe(true);
  });
});

describe('code owner coverage with email owners', () => {
  const rules = parseCodeowners('* @owner\nshared.yml @owner partner@example.com\nteam.yml @owner @org/team\n');
  const status = (file: string) => codeownerCoverage([file], rules, [], 'owner', () => false)[0]!.status;
  it('a file owned only by the author is author-only', () => {
    expect(status('src/a.ts')).toBe('author-only');
  });
  it('an email or team co-owner means the author is not the only owner', () => {
    expect(status('shared.yml')).toBe('pending');
    expect(status('team.yml')).toBe('pending');
  });
});

describe('gate-control paths (#21, #22)', () => {
  it('compares a config path with glob characters literally', () => {
    const cfg = parseConfig(ON, 'config/gate[prod].yml');
    expect(ownerOverrideFor(cfg, 'owner', 'owner', 'medium', ['config/gate[prod].yml'])).toMatchObject({ applies: false });
    expect(ownerOverrideFor(cfg, 'owner', 'owner', 'medium', ['config/gatep.yml'])).toMatchObject({ applies: true });
  });
  it('matches a ./-prefixed config path against the plain file name', () => {
    const cfg = parseConfig(ON, './config/gate.yml');
    expect(ownerOverrideFor(cfg, 'owner', 'owner', 'medium', ['config/gate.yml'])).toMatchObject({ applies: false });
  });
  it('treats local actions under .github/actions/ as gate-control files', () => {
    expect(ownerOverrideFor(parseConfig(ON), 'owner', 'owner', 'medium', ['.github/actions/setup/action.yml'])).toMatchObject({ applies: false });
  });
});
