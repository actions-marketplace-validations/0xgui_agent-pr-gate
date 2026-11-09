import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, parseConfig, withBaseMode } from '../src/config';
import { checkEvidence } from '../src/evidence';
import { decide, GateInput, renderComment, CodeownersState } from '../src/gate';
import { classify } from '../src/tiers';

const filled = '## Testing\nnpm test: 12 passed\n## Risk\nLow, one file\n## How to revert\ngit revert abc\n';
const green = { state: 'green' as const, failing: [] as string[], pending: [] as string[], passed: ['test'] };

function high(body: string, author: string, over: Partial<GateInput> = {}): GateInput {
  const cfg = parseConfig(`${body}\ntiers:\n  high: ["dist/**"]\n`);
  const codeowners: CodeownersState = {
    required: true,
    owners: { users: [author], teams: [] },
    approvedBy: [],
    satisfied: false,
    requested: [],
    coverage: [{ file: 'dist/index.js', owners: [`@${author}`], status: 'author-only', approvedBy: [] }],
  };
  return {
    cfg,
    author,
    tier: classify(['dist/index.js'], cfg),
    evidence: checkEvidence(filled, DEFAULT_SECTIONS),
    ci: green,
    approvers: [],
    codeowners,
    rounds: { rounds: 0, openedBy: [] },
    repoOwner: 'other',
    ...over,
  };
}

function comment(input: GateInput): string {
  return renderComment(input, decide(input), []);
}

describe('solo mode', () => {
  it('keeps team rules when mode is omitted', () => {
    const input = high('maintainers: [alice]', 'alice');
    expect(input.cfg.mode).toBe('team');
    const result = decide(input);
    expect(result.pass).toBe(false);
    expect(result.requiredApprovals).toBe(2);
    expect(result.problems.map((p) => p.id)).toEqual(['approvals', 'codeowners']);
    expect(comment(input)).not.toContain('Solo mode:** applied');
  });

  it('passes a high-tier PR when the author is the only listed owner and evidence and CI are present', () => {
    const input = high('mode: solo\nmaintainers: [alice]', 'alice');
    const result = decide(input);
    expect(result.pass).toBe(true);
    expect(result.requiredApprovals).toBe(0);
    expect(result.problems).toEqual([]);
    expect(comment(input)).toContain('**Solo mode:** applied.');
    expect(comment(input)).toContain('Evidence and green CI still apply.');
    expect(comment(input)).toContain('sole owner');
  });

  it('still blocks a solo PR that is missing evidence', () => {
    const input = high('mode: solo\nmaintainers: [alice]', 'alice', {
      evidence: checkEvidence('## Testing\nTODO\n## Risk\nok\n', DEFAULT_SECTIONS),
    });
    const result = decide(input);
    expect(result.pass).toBe(false);
    expect(result.problems.map((p) => p.id)).toContain('section-empty:testing');
    expect(result.problems.map((p) => p.id)).not.toContain('approvals');
  });

  it('still blocks a solo PR when CI is failing', () => {
    const input = high('mode: solo\nmaintainers: [alice]', 'alice', {
      ci: { state: 'failing', failing: ['test'], pending: [], passed: [] },
    });
    expect(decide(input).pass).toBe(false);
    expect(decide(input).problems.map((p) => p.id)).toEqual(['ci:failing']);
  });

  it('keeps team rules when routing.owners names someone else', () => {
    const input = high('mode: solo\nmaintainers: [alice]\nrouting:\n  owners: [bob]\n', 'alice');
    expect(decide(input).pass).toBe(false);
    expect(comment(input)).toContain('**Solo mode:** not applied.');
  });

  it('keeps team rules when another maintainer is listed', () => {
    const input = high('mode: solo\nmaintainers: [alice, bob]', 'alice');
    const result = decide(input);
    expect(result.pass).toBe(false);
    expect(result.requiredApprovals).toBe(2);
    expect(result.problems.map((p) => p.id)).toContain('approvals');
    expect(comment(input)).toContain('**Solo mode:** not applied.');
    expect(comment(input)).toContain('bob');
  });

  it('keeps team rules when CODEOWNERS names a team', () => {
    const input = high('mode: solo\nmaintainers: [alice]', 'alice', {
      codeowners: {
        required: true,
        owners: { users: ['alice'], teams: ['acme/reviewers'] },
        approvedBy: [],
        satisfied: false,
        requested: [],
        coverage: [{ file: 'dist/index.js', owners: ['@alice', '@acme/reviewers'], status: 'pending', approvedBy: [] }],
      },
    });
    expect(decide(input).pass).toBe(false);
    expect(decide(input).problems.map((p) => p.id)).toContain('codeowners');
    expect(comment(input)).toContain('acme/reviewers');
  });

  it('passes when solo is on, the author is the only maintainer, and there is no CODEOWNERS file', () => {
    const input = high('mode: solo\nmaintainers: [alice]', 'alice', {
      codeowners: {
        required: true,
        missingFile: true,
        owners: { users: [], teams: [] },
        approvedBy: [],
        satisfied: false,
        requested: [],
      },
    });
    expect(decide(input).pass).toBe(true);
    expect(comment(input)).toContain('**Solo mode:** applied.');
  });

  it('holds solo when there is no CODEOWNERS file and the author is not the repo owner', () => {
    const input = high('mode: solo', 'forkuser', {
      repoOwner: '0xgui',
      codeowners: {
        required: true,
        missingFile: true,
        owners: { users: [], teams: [] },
        approvedBy: [],
        satisfied: false,
        requested: [],
      },
    });
    expect(decide(input).pass).toBe(false);
    expect(comment(input)).toContain('author is not a listed owner');
  });

  it('applies solo when there is no CODEOWNERS file and the author is the repo owner', () => {
    const input = high('mode: solo', 'alice', {
      repoOwner: 'alice',
      codeowners: {
        required: true,
        missingFile: true,
        owners: { users: [], teams: [] },
        approvedBy: [],
        satisfied: false,
        requested: [],
      },
    });
    expect(decide(input).pass).toBe(true);
    expect(comment(input)).toContain('**Solo mode:** applied.');
  });

  it('applies solo when CODEOWNERS names only the author', () => {
    const input = high('mode: solo', 'alice', { repoOwner: 'other' });
    expect(input.cfg.maintainers).toEqual([]);
    expect(input.cfg.owners).toEqual([]);
    expect(decide(input).pass).toBe(true);
    expect(comment(input)).toContain('**Solo mode:** applied.');
  });

  it('does not apply solo to a fork author who is not the listed maintainer', () => {
    const input = high('mode: solo\nmaintainers: [0xgui]', 'forkuser');
    expect(decide(input).pass).toBe(false);
    expect(comment(input)).toContain('**Solo mode:** not applied.');
  });

  it('does not apply solo when a high-tier file has no CODEOWNERS entry', () => {
    const input = high('mode: solo\nmaintainers: [alice]', 'alice', {
      codeowners: {
        required: true,
        owners: { users: [], teams: [] },
        approvedBy: [],
        satisfied: false,
        requested: [],
        coverage: [{ file: 'dist/index.js', owners: [], status: 'no-owner', approvedBy: [] }],
      },
    });
    expect(decide(input).pass).toBe(false);
    expect(decide(input).problems.map((p) => p.id)).toContain('codeowners');
    expect(comment(input)).toContain('no confirmed owner');
  });

  it('still blocks a solo PR when the file list was cut off', () => {
    const input = high('mode: solo\nmaintainers: [alice]', 'alice');
    input.tier = { ...input.tier, forced: 'The PR changes 4000 files but the GitHub API only listed 3000.' };
    expect(decide(input).problems.map((p) => p.id)).toContain('files:incomplete');
  });

  it('rejects an unknown mode at parse time', () => {
    expect(() => parseConfig('mode: relaxed\n')).toThrow(/mode must be one of team, solo/);
  });

  it('takes mode from the base config, not the head config', () => {
    const head = parseConfig('mode: solo\nmaintainers: [alice]\n');
    const base = parseConfig('maintainers: [alice]\n');
    const rules = withBaseMode(head, base);
    expect(rules.mode).toBe('team');
    expect(head.mode).toBe('solo');
    const input = high('maintainers: [alice]', 'alice', { cfg: rules });
    expect(decide(input).pass).toBe(false);
  });
});
