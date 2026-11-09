// This repo's own .review-gate.yml, as REVIEW_POLICY.md describes it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, parseConfig } from '../src/config';
import { checkEvidence } from '../src/evidence';
import { decide, GateInput } from '../src/gate';
import { classify } from '../src/tiers';

describe("this repo's review round cap", () => {
  const cfg = parseConfig(readFileSync('.review-gate.yml', 'utf8'));
  const input = (rounds: number): GateInput => ({
    cfg,
    author: 'agent',
    tier: classify(['docs/a.md'], cfg),
    evidence: checkEvidence('## Testing\n42 passed\n## Risk\nlow\n## How to revert\ngit revert', DEFAULT_SECTIONS),
    ci: { state: 'green', failing: [], pending: [], passed: ['test'] },
    approvers: [],
    codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
    rounds: { rounds, openedBy: [] },
    repoOwner: '0xgui',
  });
  it('is 2, matching REVIEW_POLICY.md', () => {
    expect(cfg.roundCap).toBe(2);
    expect(readFileSync('REVIEW_POLICY.md', 'utf8')).toContain('`rounds.cap: 2`');
  });
  it('flags a PR at round 2 but not at round 1, without changing pass or fail', () => {
    expect(decide(input(1)).roundCapReached).toBe(false);
    const atCap = decide(input(2));
    expect(atCap.roundCapReached).toBe(true);
    expect(atCap.pass).toBe(true);
  });
});
