import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, parseConfig } from '../src/config';
import { checkEvidence, hasContent } from '../src/evidence';
import { decide, GateInput, renderComment } from '../src/gate';
import { classify } from '../src/tiers';

const cfg = parseConfig('tiers:\n  high: ["dist/**"]\nmaintainers: [alice]\n');
const filled = '## Testing\nnpm test: 12 passed\n## Risk\nLow\n## How to revert\ngit revert abc\n';
const green = { state: 'green' as const, failing: [] as string[], pending: [] as string[], passed: ['test'] };

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    cfg,
    author: 'alice',
    repoOwner: 'alice',
    tier: classify(['dist/index.js'], cfg),
    evidence: checkEvidence(filled, DEFAULT_SECTIONS),
    ci: green,
    approvers: [],
    codeowners: { required: true, owners: { users: ['alice'], teams: [] }, approvedBy: [], satisfied: false, requested: [], coverage: [{ file: 'dist/index.js', owners: ['@alice'], status: 'author-only', approvedBy: [] }] },
    rounds: { rounds: 0, openedBy: [] },
    ...over,
  };
}

describe('comment layout', () => {
  it('leads a blocked comment with the next action', () => {
    const body = renderComment(input({ evidence: checkEvidence('## Testing\nN/A\n## Risk\nok\n## How to revert\nok\n', DEFAULT_SECTIONS) }), decide(input({ evidence: checkEvidence('## Testing\nN/A\n## Risk\nok\n## How to revert\nok\n', DEFAULT_SECTIONS) })), []);
    const missing = body.indexOf('### What is missing');
    const details = body.indexOf('<details><summary>Details</summary>');
    expect(missing).toBeGreaterThan(0);
    expect(missing).toBeLessThan(details);
    expect(body.slice(missing, details)).toContain('N/A, no runtime change');
    expect(body.slice(missing, details)).toContain('Who: author');
    expect(body.indexOf('**Risk tier:**')).toBeGreaterThan(details);
  });

  it('tells the author when only a maintainer can clear the block', () => {
    const blocked = input({
      cfg: parseConfig('mode: solo\ntiers:\n  high: ["dist/**"]\nmaintainers: [alice, bob]\n'),
      repoOwner: 'other',
      codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
    });
    const body = renderComment(blocked, decide(blocked), []);
    const missing = body.slice(body.indexOf('### What is missing'), body.indexOf('<details><summary>Details</summary>'));
    expect(missing).toContain('Who: maintainer');
    expect(missing).toContain('You cannot fix this by editing the pull request.');
    expect(missing).toContain('routing.approvals.high');
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)![1]!);
    expect(json.schema_version).toBe(1);
    expect(json.missing.map((m: { id: string }) => m.id)).not.toContain('rounds:cap');
  });

  it('uses one short line when the pull request passed', () => {
    const ok = input({
      cfg: parseConfig('mode: solo\ntiers:\n  high: ["dist/**"]\nmaintainers: [alice]\n'),
      approvers: [],
    });
    const result = decide(ok);
    expect(result.pass).toBe(true);
    const body = renderComment(ok, result, []);
    expect(body).toContain('This pull request passed.');
    expect(body.indexOf('This pull request passed.')).toBeLessThan(body.indexOf('<details><summary>Details</summary>'));
    expect(body.slice(0, body.indexOf('<details>'))).not.toContain('### What is missing');
    expect(body).toContain('**Risk tier:**');
  });
});

describe('N/A rule', () => {
  it('keeps a reason after N/A and rejects a bare N/A', () => {
    expect(hasContent('N/A')).toBe(false);
    expect(hasContent('N/A, no runtime change')).toBe(true);
    expect(hasContent('N/A: later')).toBe(false);
    const bare = input({ evidence: checkEvidence('## Testing\nN/A\n## Risk\nok\n## How to revert\nok\n', DEFAULT_SECTIONS) });
    const fix = decide(bare).problems.find((p) => p.section === 'Testing')!.fix;
    expect(fix).toContain('N/A, no runtime change');
    expect(fix).toContain('N/A: later');
  });
});
