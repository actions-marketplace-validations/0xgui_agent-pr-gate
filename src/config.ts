import type { ScopeConfig } from './scope';
import { LineCounter, parseDocument, isSeq, isScalar } from 'yaml';

export type Tier = 'low' | 'medium' | 'high';
export const TIERS: Tier[] = ['low', 'medium', 'high'];

/** `team` is the default. `solo` can waive high-tier reviews when the author is the only listed owner. */
export type GateMode = 'team' | 'solo';
export const GATE_MODES: GateMode[] = ['team', 'solo'];

export interface TierGlob {
  /** Normalized glob, as matched. */
  glob: string;
  /** As written in the config, when it differs from `glob`. */
  raw?: string;
  /** Only match from the repo root (the pattern started with "/" or "./"). */
  anchored?: boolean;
  /** 1-based line in the config file where this glob is declared. */
  line?: number;
}

export interface SectionSpec {
  name: string;
  aliases: string[];
}

export interface GateConfig {
  path: string;
  /** Parsed at the config boundary. Missing means `team`. */
  mode: GateMode;
  defaultTier: Tier;
  tiers: Record<Tier, TierGlob[]>;
  sections: SectionSpec[];
  requireGreenCi: boolean;
  ignoreChecks: string[];
  approvals: Record<Tier, number>;
  highRequiresCodeowners: boolean;
  /** Count approvals given on an older head commit. */
  allowStaleApprovals: boolean;
  /** author_association values whose approvals count. */
  trustedAssociations: string[];
  /** Let a listed owner's own PR satisfy the approval rules (single-maintainer repos). */
  ownerOverride: boolean;
  /** Logins the owner override applies to. Empty means the repository owner. */
  owners: string[];
  /** Tiers the owner override may waive. Never contains high. */
  ownerOverrideTiers: Tier[];
  /** Which PRs the gate enforces. Always read from the base commit (see configRefs). */
  scope: ScopeConfig;
  roundCap: number;
  roundReviewStates: string[];
  maintainers: string[];
  revertLookbackDays: number;
  /** True when no config file was found and defaults are in use. */
  missing?: boolean;
}

export const DEFAULT_SECTIONS: SectionSpec[] = [
  { name: 'Testing', aliases: ['Tests', 'Test plan'] },
  { name: 'Risk', aliases: ['Risks'] },
  { name: 'How to revert', aliases: ['Revert', 'Rollback', 'Revert plan', 'Rollback plan'] },
];

export function defaultConfig(path = '.review-gate.yml'): GateConfig {
  return {
    path,
    mode: 'team',
    defaultTier: 'medium',
    tiers: { low: [], medium: [], high: [] },
    sections: DEFAULT_SECTIONS.map((s) => ({ ...s, aliases: [...s.aliases] })),
    requireGreenCi: true,
    ignoreChecks: [],
    approvals: { low: 0, medium: 1, high: 2 },
    highRequiresCodeowners: true,
    allowStaleApprovals: false,
    trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    ownerOverride: false,
    owners: [],
    ownerOverrideTiers: ['low', 'medium'],
    scope: { authors: [], bots: false, labels: [] },
    roundCap: 3,
    roundReviewStates: ['CHANGES_REQUESTED'],
    maintainers: [],
    revertLookbackDays: 30,
  };
}

export class ConfigError extends Error {}

/**
 * Commits to read the config from. The rules follow the config-ref input. Scope always comes from
 * the base commit, so a PR cannot take itself out of scope, even with config-ref: head.
 */
export function configRefs(configRef: string, pr: { base: { sha: string }; head: { sha: string } }): { rules: string; scope: string } {
  return { rules: configRef === 'head' ? pr.head.sha : pr.base.sha, scope: pr.base.sha };
}

/**
 * `mode` always comes from the base commit. A pull request cannot turn `solo` on by editing
 * the head copy, even when `config-ref` is `head`.
 */
export function withBaseMode(rules: GateConfig, base: GateConfig): GateConfig {
  if (rules.mode === base.mode) return rules;
  return { ...rules, mode: base.mode };
}

function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as string[]).includes(v);
}

function asStringList(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ConfigError(`${where} must be a list of strings`);
  }
  return v as string[];
}

/**
 * Normalize a tier glob: strip a leading "./" or "/" (both anchor it to the repo root) and expand
 * a trailing "/" to "/**". Throws on patterns that can never match a changed path.
 */
export function normalizeGlob(raw: string, where: string): { glob: string; anchored: boolean } {
  let g = raw.trim();
  if (!g) throw new ConfigError(`${where}: empty glob`);
  if (g.startsWith('!')) throw new ConfigError(`${where}: negated globs ("${raw}") are not supported`);
  if (g.includes('\\')) throw new ConfigError(`${where}: use "/" not "\\" in "${raw}"`);
  let anchored = false;
  if (g.startsWith('./')) {
    g = g.slice(2);
    anchored = true;
  } else if (g.startsWith('/')) {
    g = g.replace(/^\/+/, '');
    anchored = true;
  }
  if (g.endsWith('/')) g = g.replace(/\/+$/, '') + '/**';
  if (!g || g === '/**') throw new ConfigError(`${where}: "${raw}" matches nothing; use "**" for every file`);
  if (g.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new ConfigError(`${where}: "${raw}" has an empty, "." or ".." path segment`);
  }
  return { glob: g, anchored: anchored || g.includes('/') };
}

function asNonNegInt(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new ConfigError(`${where} must be a non-negative integer`);
  }
  return v;
}

/** Parse `.review-gate.yml` text. Missing keys fall back to defaults. */
export function parseConfig(text: string, path = '.review-gate.yml'): GateConfig {
  const cfg = defaultConfig(path);
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    throw new ConfigError(`${path}: invalid YAML: ${doc.errors[0]?.message ?? 'unknown error'}`);
  }
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${path}: top level must be a mapping`);
  }

  if (raw.mode !== undefined) {
    if (raw.mode !== 'team' && raw.mode !== 'solo') {
      throw new ConfigError(`mode must be one of ${GATE_MODES.join(', ')}`);
    }
    cfg.mode = raw.mode;
  }

  if (raw.default_tier !== undefined) {
    if (!isTier(raw.default_tier)) throw new ConfigError(`default_tier must be one of ${TIERS.join(', ')}`);
    cfg.defaultTier = raw.default_tier;
  }

  if (raw.tiers !== undefined && raw.tiers !== null) {
    if (typeof raw.tiers !== 'object' || Array.isArray(raw.tiers)) {
      throw new ConfigError('tiers must be a mapping of tier name to a list of globs');
    }
    for (const key of Object.keys(raw.tiers)) {
      if (!isTier(key)) throw new ConfigError(`unknown tier "${key}" (use ${TIERS.join(', ')})`);
      const globs = asStringList((raw.tiers as Record<string, unknown>)[key], `tiers.${key}`);
      const node = doc.getIn(['tiers', key], true);
      cfg.tiers[key] = globs.map((raw, i) => {
        let line: number | undefined;
        if (isSeq(node)) {
          const item = node.items[i];
          if (isScalar(item) && item.range) line = lineCounter.linePos(item.range[0]).line;
        }
        const { glob, anchored } = normalizeGlob(raw, `${path}:${line ?? '?'} tiers.${key}`);
        return { glob, line, anchored, ...(glob !== raw ? { raw } : {}) };
      });
    }
  }

  const evidence = (raw.evidence ?? {}) as Record<string, unknown>;
  if (evidence.sections !== undefined) {
    if (!Array.isArray(evidence.sections)) throw new ConfigError('evidence.sections must be a list');
    cfg.sections = evidence.sections.map((s, i) => {
      if (typeof s === 'string') return { name: s, aliases: [] };
      if (s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string') {
        const o = s as { name: string; aliases?: unknown };
        return { name: o.name, aliases: asStringList(o.aliases, `evidence.sections[${i}].aliases`) };
      }
      throw new ConfigError(`evidence.sections[${i}] must be a string or {name, aliases}`);
    });
  }
  if (evidence.require_green_ci !== undefined) {
    if (typeof evidence.require_green_ci !== 'boolean') throw new ConfigError('evidence.require_green_ci must be a boolean');
    cfg.requireGreenCi = evidence.require_green_ci;
  }
  cfg.ignoreChecks = asStringList(evidence.ignore_checks, 'evidence.ignore_checks');

  const routing = (raw.routing ?? {}) as Record<string, unknown>;
  if (routing.approvals !== undefined) {
    const a = routing.approvals as Record<string, unknown>;
    if (typeof a !== 'object' || a === null) throw new ConfigError('routing.approvals must be a mapping');
    for (const key of Object.keys(a)) {
      if (!isTier(key)) throw new ConfigError(`routing.approvals: unknown tier "${key}"`);
      cfg.approvals[key] = asNonNegInt(a[key], `routing.approvals.${key}`);
    }
  }
  if (routing.high_requires_codeowners !== undefined) {
    if (typeof routing.high_requires_codeowners !== 'boolean') {
      throw new ConfigError('routing.high_requires_codeowners must be a boolean');
    }
    cfg.highRequiresCodeowners = routing.high_requires_codeowners;
  }

  if (routing.allow_stale_approvals !== undefined) {
    if (typeof routing.allow_stale_approvals !== 'boolean') throw new ConfigError('routing.allow_stale_approvals must be a boolean');
    cfg.allowStaleApprovals = routing.allow_stale_approvals;
  }
  if (routing.trusted_associations !== undefined) {
    cfg.trustedAssociations = asStringList(routing.trusted_associations, 'routing.trusted_associations').map((s) => s.toUpperCase());
    // An empty list would trust every reviewer, so reject it (fail closed, #38).
    if (cfg.trustedAssociations.length === 0) throw new ConfigError('routing.trusted_associations must list at least one association, for example [OWNER, MEMBER, COLLABORATOR]');
  }
  if (routing.owner_override !== undefined) {
    if (typeof routing.owner_override !== 'boolean') throw new ConfigError('routing.owner_override must be a boolean');
    cfg.ownerOverride = routing.owner_override;
  }
  cfg.owners = asStringList(routing.owners, 'routing.owners').map((o) => o.replace(/^@/, ''));
  if (routing.owner_override_tiers !== undefined) {
    const tiers = asStringList(routing.owner_override_tiers, 'routing.owner_override_tiers').map((t) => t.toLowerCase());
    for (const t of tiers) {
      if (!isTier(t)) throw new ConfigError(`routing.owner_override_tiers: unknown tier "${t}"`);
      if (t === 'high') throw new ConfigError('routing.owner_override_tiers cannot include high: the owner override never waives high-tier approvals');
    }
    cfg.ownerOverrideTiers = tiers as Tier[];
  }

  if (raw.scope !== undefined && raw.scope !== null) {
    if (typeof raw.scope !== 'object' || Array.isArray(raw.scope)) throw new ConfigError('scope must be a mapping with authors, bots and labels');
    const scope = raw.scope as Record<string, unknown>;
    if (scope.bots !== undefined && typeof scope.bots !== 'boolean') throw new ConfigError('scope.bots must be a boolean');
    cfg.scope = {
      authors: asStringList(scope.authors, 'scope.authors').map((a) => a.replace(/^@/, '')),
      bots: scope.bots === true,
      labels: asStringList(scope.labels, 'scope.labels'),
    };
  }

  const rounds = (raw.rounds ?? {}) as Record<string, unknown>;
  if (rounds.cap !== undefined) cfg.roundCap = asNonNegInt(rounds.cap, 'rounds.cap');
  if (rounds.review_states !== undefined) {
    cfg.roundReviewStates = asStringList(rounds.review_states, 'rounds.review_states').map((s) => s.toUpperCase());
  }

  cfg.maintainers = asStringList(raw.maintainers, 'maintainers').map((m) => m.replace(/^@/, ''));

  const metrics = (raw.metrics ?? {}) as Record<string, unknown>;
  if (metrics.revert_lookback_days !== undefined) {
    cfg.revertLookbackDays = asNonNegInt(metrics.revert_lookback_days, 'metrics.revert_lookback_days');
  }

  return cfg;
}
