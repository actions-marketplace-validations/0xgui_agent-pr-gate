// One regression test per review finding on PR #1 (the numbers match that review).
import { describe, expect, it } from 'vitest';
import { codeownerCoverage, codeownersMatch, ownersFor, parseCodeowners } from '../src/codeowners';
import { DEFAULT_SECTIONS, parseConfig } from '../src/config';
import { checkEvidence, parseSections } from '../src/evidence';
import { decide, GateInput, MARKER, pickGateComments, renderComment } from '../src/gate';
import { classify } from '../src/tiers';

const status = (body: string) => Object.fromEntries(checkEvidence(body, DEFAULT_SECTIONS).map((e) => [e.name, e.status]));

describe('#1 empty section followed by a bold label or subheading', () => {
  it('TODO then **Risk:** leaves Testing empty', () => {
    expect(status('## Testing\nTODO\n**Risk:** low\n## How to revert\ngit revert').Testing).toBe('empty');
  });
  it('blank then ### Risk leaves Testing empty', () => {
    expect(status('## Testing\n\n### Risk\nlow\n## How to revert\ngit revert').Testing).toBe('empty');
  });
  it('a non-required subheading with content still fills its parent', () => {
    expect(status('## Testing\n### Unit\nnpm test passed\n').Testing).toBe('ok');
  });
  it('placeholder-only content (TODO, TBD, N/A, -) is empty', () => {
    expect(status('## Testing\nTBD\n## Risk\nN/A\n## How to revert\n-\n')).toEqual({ Testing: 'empty', Risk: 'empty', 'How to revert': 'empty' });
  });
});

describe('#2 #3 approvals (see reviews.test.ts) are wired into the gate comment', () => {
  it('names stale and untrusted approvers in the fix', () => {
    const cfg = parseConfig('');
    const input: GateInput = {
      cfg,
      author: 'agent',
      tier: classify(['src/a.ts'], cfg),
      evidence: checkEvidence('## Testing\nok\n## Risk\nok\n## How to revert\nok', DEFAULT_SECTIONS),
      ci: null,
      approvers: [],
      ignoredApprovals: { stale: ['alice'], untrusted: ['stranger'] },
      codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
      rounds: { rounds: 0, openedBy: [] },
      repoOwner: 'agent',
    };
    const fix = decide(input).problems.find((p) => p.id === 'approvals')!.fix;
    expect(fix).toContain('Stale (re-approve the latest commit): @alice');
    expect(fix).toContain('Not counted (no repo access): @stranger');
  });
});

describe('#5 only adopt the gate own marker comment', () => {
  it('ignores marker comments written by other users', () => {
    const comments = [
      { id: 1, body: `${MARKER}\nfake pass`, user: { login: 'mallory' } },
      { id: 2, body: `${MARKER}\nreal`, user: { login: 'github-actions[bot]' } },
      { id: 3, body: 'hello', user: { login: 'github-actions[bot]' } },
    ];
    expect(pickGateComments(comments, 'github-actions[bot]').map((c) => c.id)).toEqual([2]);
  });
});

describe('#6 tier glob normalization', () => {
  const cfg = parseConfig('tiers:\n  high:\n    - "/action.yml"\n    - "./scripts/deploy.sh"\n    - ".github/"\n');
  it('normalizes leading / and ./ and a trailing /', () => {
    expect(cfg.tiers.high.map((g) => g.glob)).toEqual(['action.yml', 'scripts/deploy.sh', '.github/**']);
    expect(classify(['action.yml'], cfg).tier).toBe('high');
    expect(classify(['scripts/deploy.sh'], cfg).tier).toBe('high');
    expect(classify(['.github/workflows/ci.yml'], cfg).tier).toBe('high');
  });
  it('keeps a leading / anchored to the root', () => {
    expect(classify(['sub/action.yml'], cfg).tier).toBe('medium');
    expect(classify(['sub/action.yml'], parseConfig('tiers:\n  high: ["action.yml"]\n')).tier).toBe('high');
  });
  it('rejects patterns that can never match', () => {
    expect(() => parseConfig('tiers:\n  high: ["/"]\n')).toThrow(/matches nothing/);
    expect(() => parseConfig('tiers:\n  high: ["!docs/**"]\n')).toThrow(/negated/);
    expect(() => parseConfig('tiers:\n  high: ["../x"]\n')).toThrow(/segment/);
    expect(() => parseConfig('tiers:\n  high: [""]\n')).toThrow(/empty glob/);
    expect(() => parseConfig('tiers:\n  high: ["src\\\\auth\\\\**"]\n')).toThrow(/use "\/"/);
  });
});

describe('#7 truncated file list forces high', () => {
  it('forces high and says why when the API listed fewer files than changed', () => {
    const cfg = parseConfig('tiers:\n  low: ["docs/**"]\n');
    const r = classify(['docs/a.md'], cfg, { total: 3500, seen: 3000 });
    expect(r.tier).toBe('high');
    expect(r.forced).toMatch(/3500 files.*only listed 3000/);
    expect(classify(['docs/a.md'], cfg, { total: 1, seen: 1 }).tier).toBe('low');
  });
});

describe('#8 code owner approval is required per file', () => {
  const rules = parseCodeowners('/.github/ @alice\n/charts/ @bob\n');
  const none = () => null;
  it('one owner does not cover another owner files', () => {
    const cov = codeownerCoverage(['.github/workflows/ci.yml', 'charts/values.yaml'], rules, ['alice'], 'agent', none);
    expect(cov.map((c) => c.status)).toEqual(['approved', 'pending']);
  });
  it('is satisfied once each file has an owner approval', () => {
    const cov = codeownerCoverage(['.github/workflows/ci.yml', 'charts/values.yaml'], rules, ['alice', 'bob'], 'agent', none);
    expect(cov.every((c) => c.status === 'approved')).toBe(true);
  });
  it('flags files with no owner and files owned only by the author', () => {
    const cov = codeownerCoverage(['infra/main.tf', '.github/x.yml'], rules, [], 'alice', none);
    expect(cov.map((c) => c.status)).toEqual(['no-owner', 'author-only']);
  });
});

describe('#9 unknown team membership is reported, not treated as no', () => {
  it('marks the file team-unknown when the lookup could not tell', () => {
    const rules = parseCodeowners('* @org/infra\n');
    expect(codeownerCoverage(['a.tf'], rules, ['carol'], 'agent', () => null)[0]!.status).toBe('team-unknown');
    expect(codeownerCoverage(['a.tf'], rules, ['carol'], 'agent', () => true)[0]!.status).toBe('approved');
    expect(codeownerCoverage(['a.tf'], rules, ['carol'], 'agent', () => false)[0]!.status).toBe('pending');
  });
  it('shows the branch protection note in the comment', () => {
    const cfg = parseConfig('tiers:\n  high: ["**"]\n');
    const input: GateInput = {
      cfg,
      author: 'agent',
      tier: classify(['a.tf'], cfg),
      evidence: checkEvidence('## Testing\nok\n## Risk\nok\n## How to revert\nok', DEFAULT_SECTIONS),
      ci: null,
      approvers: ['carol', 'dave'],
      codeowners: {
        required: true,
        owners: { users: [], teams: ['org/infra'] },
        approvedBy: [],
        satisfied: false,
        requested: [],
        coverage: [{ file: 'a.tf', owners: ['@org/infra'], approvedBy: [], status: 'team-unknown' }],
        note: 'Could not confirm membership of @org/infra with this token (404 or no org access). Branch protection must enforce the team review.',
      },
      rounds: { rounds: 0, openedBy: [] },
      repoOwner: 'agent',
    };
    expect(renderComment(input, decide(input), [])).toContain('Branch protection must enforce the team review');
  });
});

describe('#12 mixed fence types', () => {
  it('a ~~~ line does not close a ``` fence', () => {
    const body = '```\n~~~\n## Testing\nfake\n```\n## Risk\nlow\n';
    expect(status(body)).toMatchObject({ Testing: 'missing', Risk: 'ok' });
  });
  it('a shorter fence does not close a longer one', () => {
    expect(status('````\n```\n## Testing\nfake\n````\n').Testing).toBe('missing');
  });
  it('content inside a fence still fills a section', () => {
    expect(status('## Testing\n```\n$ npm test\n43 passed\n```\n').Testing).toBe('ok');
  });
});

describe('#13 setext headings and bold prose', () => {
  it('recognises setext headings', () => {
    expect(status('Testing\n=======\nran it\n\nRisk\n----\nlow\n')).toMatchObject({ Testing: 'ok', Risk: 'ok' });
  });
  it('does not treat bold prose as a heading', () => {
    expect(status('**Testing** was not done.\n').Testing).toBe('missing');
    expect(parseSections('Some **Risk** here').length).toBe(0);
  });
  it('accepts whole-line bold labels with or without a colon', () => {
    expect(status('**Testing**\nran it\n**Risk**:\nlow\n**How to revert:**\nrevert\n')).toEqual({ Testing: 'ok', Risk: 'ok', 'How to revert': 'ok' });
  });
});

describe('#14 empty tiers key', () => {
  it('treats `tiers:` with no value as no tiers', () => {
    const cfg = parseConfig('default_tier: low\ntiers:\n');
    expect(cfg.tiers).toEqual({ low: [], medium: [], high: [] });
    expect(parseConfig('tiers:\n  high:\n').tiers.high).toEqual([]);
  });
});

describe('#15 GitHub CODEOWNERS semantics', () => {
  it('docs/* matches one level only', () => {
    expect(codeownersMatch('docs/a.md', 'docs/*')).toBe(true);
    expect(codeownersMatch('docs/sub/b.md', 'docs/*')).toBe(false);
  });
  it('a trailing / or a plain name covers the whole directory', () => {
    expect(codeownersMatch('apps/x/y.ts', 'apps/')).toBe(true);
    expect(codeownersMatch('pkg/apps/x.ts', 'apps/')).toBe(true);
    expect(codeownersMatch('build/logs/a/b.log', '/build/logs')).toBe(true);
    expect(codeownersMatch('deep/nested/logs/x', '**/logs')).toBe(true);
  });
  it('* and *.ext match at any depth, anchored paths only from root', () => {
    expect(codeownersMatch('a/b/c.js', '*.js')).toBe(true);
    expect(codeownersMatch('a/b/c', '*')).toBe(true);
    expect(codeownersMatch('x/docs/a.md', '/docs/')).toBe(false);
    expect(ownersFor('docs/sub/b.md', parseCodeowners('* @all\ndocs/* @docs\n'))).toEqual(['@all']);
  });
});

describe('N1 a 4-backtick block cannot hide or fake sections', () => {
  it('wrapping the whole body in ```` with inner ``` lines makes every section missing', () => {
    const body = '````markdown\n```\n## Testing\nran\n```\n## Risk\nlow\n## How to revert\nrevert\n````\n';
    expect(status(body)).toEqual({ Testing: 'missing', Risk: 'missing', 'How to revert': 'missing' });
  });
  it('a closing fence may be longer than the opener', () => {
    expect(status('```\n## Testing\nfake\n`````\n## Testing\nreal\n').Testing).toBe('ok');
  });
});

describe('N2 filler does not count as content', () => {
  it('<br>, emphasised TODO, hr and empty bullets are empty', () => {
    expect(status('## Testing\n<br>\n').Testing).toBe('empty');
    expect(status('## Testing\n<p></p>&nbsp;\n').Testing).toBe('empty');
    expect(status('## Testing\n**TODO:** describe tests\n').Testing).toBe('empty');
    expect(status('## Testing\n_TBD_\n***\n- \n* [ ]\n> \n').Testing).toBe('empty');
    expect(status('## Testing\n_No response_\n').Testing).toBe('empty');
  });
  it('real text with emphasis or tags still counts', () => {
    expect(status('## Testing\n**Ran** `npm test`<br>43 passed\n').Testing).toBe('ok');
  });
});

describe('B bold labels that are not required sections fill their parent', () => {
  it('## Testing with **Unit:** 42 passed is filled', () => {
    expect(status('## Testing\n**Unit:** 42 passed\n## Risk\nlow\n## How to revert\nrevert\n')).toEqual({ Testing: 'ok', Risk: 'ok', 'How to revert': 'ok' });
    expect(status('## Testing\n**Unit**\n42 passed\n').Testing).toBe('ok');
    // A bold sibling never fills a bold-label parent (R1); nest it as a list item instead.
    expect(status('**Testing:**\n- **Unit:** 42 passed\n').Testing).toBe('ok');
  });
  it('placeholder bold labels and required bold labels still do not fill it', () => {
    expect(status('## Testing\n**TODO:** describe tests\n').Testing).toBe('empty');
    expect(status('## Testing\n**Unit:**\n**TBD**\n').Testing).toBe('empty');
    expect(status('## Testing\nTODO\n**Risk:** low\n').Testing).toBe('empty');
    expect(status('## Testing\n## Other\n**Unit:** 42 passed\n').Testing).toBe('empty');
  });
});

describe('C incomplete file list blocks', () => {
  it('adds a blocking problem even when listed files are approved by their owners', () => {
    const cfg = parseConfig('tiers:\n  low: ["docs/**"]\nrouting:\n  high_requires_codeowners: false\n');
    const input: GateInput = {
      cfg,
      author: 'agent',
      tier: classify(['docs/a.md'], cfg, { total: 3500, seen: 3000 }),
      evidence: checkEvidence('## Testing\nok\n## Risk\nok\n## How to revert\nok', DEFAULT_SECTIONS),
      ci: null,
      approvers: ['alice', 'bob'],
      codeowners: { required: false, owners: { users: [], teams: [] }, approvedBy: [], satisfied: true, requested: [] },
      rounds: { rounds: 0, openedBy: [] },
      repoOwner: 'agent',
    };
    const res = decide(input);
    expect(res.pass).toBe(false);
    expect(res.problems.map((p) => p.id)).toEqual(['files:incomplete']);
    expect(renderComment(input, res, [])).toContain('Incomplete file list');
  });
});

describe('R1 placeholders under bold labels are empty (label text is never content)', () => {
  it.each([
    ['## Testing\n**Unit tests:** TODO\n'],
    ['## Testing\n**Unit tests:** N/A\n'],
    ['## Testing\n**Unit tests:** -\n'],
    ['## Testing\n**Unit tests:**\nTODO\n'],
    ['## Testing\n**Unit tests**\nTBD\n'],
    ['**Testing:** TODO\n**Notes:** refactor\n'],
    ['**Testing:**\n**Notes:** refactor\n'],
  ])('%j is empty', (body) => {
    expect(status(body).Testing).toBe('empty');
  });
  it('real text under a bold label, or indented under a bold parent, still fills it', () => {
    expect(status('## Testing\n**Unit:** 42 passed\n').Testing).toBe('ok');
    expect(status('## Testing\n**Unit tests:**\n42 passed\n').Testing).toBe('ok');
    expect(status('**Testing:**\n- **Unit:** 42 passed\n').Testing).toBe('ok');
    expect(status('**Testing:** npm test, 42 passed\n**Notes:** refactor\n').Testing).toBe('ok');
  });
});
