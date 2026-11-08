import { Minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import { codeownersMatch } from '../src/codeowners';
import { defaultConfig, parseConfig } from '../src/config';
import { gateControlTouched } from '../src/gate';
import { classify, classifyFile } from '../src/tiers';

const cfg = parseConfig(`default_tier: medium
tiers:
  low:
    - "docs/**"
    - "*.md"
  medium:
    - "src/**"
  high:
    - ".github/workflows/**"
    - "charts/**"
    - "src/auth/**"
`);

describe('tier matcher', () => {
  it('records the config line of each glob', () => {
    expect(cfg.tiers.high.map((g) => g.line)).toEqual([9, 10, 11]);
    expect(cfg.tiers.low[0]).toMatchObject({ glob: 'docs/**', line: 4 });
  });

  it('matches docs as low and dotfiles under .github', () => {
    expect(classifyFile('docs/guide/intro.md', cfg).tier).toBe('low');
    expect(classifyFile('.github/workflows/ci.yml', cfg).tier).toBe('high');
  });

  it('matches slash-less globs at any depth', () => {
    expect(classifyFile('packages/a/README.md', cfg).tier).toBe('low');
  });

  it('prefers the highest tier when a file matches several', () => {
    expect(classifyFile('src/auth/login.ts', cfg)).toMatchObject({ tier: 'high', glob: 'src/auth/**', line: 11 });
  });

  it('uses the default tier for unmatched files', () => {
    expect(classifyFile('package.json', cfg)).toEqual({ file: 'package.json', tier: 'medium' });
  });

  it('takes the highest tier across files and reports the triggers', () => {
    const r = classify(['docs/a.md', 'src/x.ts', 'charts/app/values.yaml'], cfg);
    expect(r.tier).toBe('high');
    expect(r.triggers.map((t) => t.file)).toEqual(['charts/app/values.yaml']);
  });

  it('stays low when every file is low', () => {
    expect(classify(['docs/a.md', 'README.md'], cfg).tier).toBe('low');
  });

  it('falls back to the default tier with no files', () => {
    expect(classify([], cfg).tier).toBe('medium');
  });

  it('honours a low default tier', () => {
    const c = parseConfig('default_tier: low\ntiers:\n  high: ["infra/**"]\n');
    expect(classify(['misc.txt'], c).tier).toBe('low');
    expect(classify(['misc.txt', 'infra/main.tf'], c).tier).toBe('high');
  });

  it('keeps **/.. patterns off minimatch optimization level 2', () => {
    expect(() => parseConfig('tiers:\n  high: ["src/**/../**/*.ts"]\n')).toThrow(/path segment/);
    const compiled = new Minimatch('**/../a/b', { dot: true });
    expect(compiled.options.optimizationLevel ?? 1).toBe(1);
    expect(compiled.set).toHaveLength(1);
    expect(codeownersMatch('pre/../a/b', '**/../a/b')).toBe(true);
    expect(codeownersMatch('x/a/b', '**/../a/b')).toBe(false);
    expect(gateControlTouched(defaultConfig('.review-gate.yml'), ['dist/index.js', 'README.md'])).toEqual(['dist/index.js']);
  });
});

describe('config parsing', () => {
  it('rejects unknown tiers and bad values', () => {
    expect(() => parseConfig('tiers:\n  critical: ["x"]\n')).toThrow(/unknown tier/);
    expect(() => parseConfig('default_tier: urgent\n')).toThrow(/default_tier/);
    expect(() => parseConfig('rounds:\n  cap: -1\n')).toThrow(/rounds.cap/);
  });

  it('accepts string and object sections', () => {
    const c = parseConfig('evidence:\n  sections:\n    - Testing\n    - name: Rollout\n      aliases: [Deploy plan]\n');
    expect(c.sections).toEqual([
      { name: 'Testing', aliases: [] },
      { name: 'Rollout', aliases: ['Deploy plan'] },
    ]);
  });

  it('uses defaults for an empty file', () => {
    const c = parseConfig('');
    expect(c.defaultTier).toBe('medium');
    expect(c.approvals).toEqual({ low: 0, medium: 1, high: 2 });
    expect(c.roundCap).toBe(3);
  });
});

describe('repo config', () => {
  it('parses this repo .review-gate.yml', async () => {
    const { readFileSync } = await import('fs');
    const c = parseConfig(readFileSync('.review-gate.yml', 'utf8'));
    expect(classify(['README.md'], c).tier).toBe('low');
    expect(classify(['src/main.ts'], c).tier).toBe('medium');
    expect(classify(['dist/index.js', 'README.md'], c).tier).toBe('high');
    expect(c.maintainers).toEqual(['0xgui']);
  });
});
