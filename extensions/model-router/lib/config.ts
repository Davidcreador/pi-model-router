/**
 * Config loading, merging, validation, and hot-reload.
 *
 * Sources (deep-merged, project wins):
 *   - global:  ~/.pi/agent/model-router.json
 *   - project: <cwd>/.pi/model-router.json
 *
 * The global file is written from a starter template on first run so a fresh
 * install is immediately useful. Parse errors keep the last good config and
 * surface a single notification instead of crashing the session.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { RouterConfig, Phase, RouteConfig } from "./types.ts";

/** Default verb lexicon per phase. */
const DEFAULT_LEXICON: Record<Phase, string[]> = {
  investigate: [
    "find", "where", "locate", "search", "look", "trace", "understand",
    "explain", "read", "inspect", "how does", "what is", "what's", "show me",
  ],
  plan: [
    "plan", "design", "approach", "architecture", "propose", "options",
    "tradeoff", "should we", "strategy", "spec", "how should", "scope",
  ],
  implement: [
    "implement", "add", "build", "create", "write", "fix", "refactor",
    "change", "update", "rename", "migrate", "wire", "hook up", "make it",
  ],
  review: [
    "review", "audit", "check", "pr ", "diff", "regression", "smell",
    "vulnerab", "lgtm", "look over", "critique",
  ],
  debug: [
    "debug", "error", "exception", "stacktrace", "traceback", "failing",
    "crash", "repro", "why is", "not working", "broken", "fails",
  ],
};

/** Default signal weights (overridable). */
const DEFAULT_WEIGHTS: Record<string, number> = {
  "verb": 0.45,
  "question-shape": 0.2,
  "command-shape": 0.2,
  "tools": 0.3,
  "speed-word": 0.25,
  "depth-word": 0.25,
  "rule": 0.9,
  // hard signals
  "diff": 0.8,
  "stacktrace": 0.8,
  "image": 0.8,
  "slash": 1.0,
};

/** The starter config written on first run. Prefilled from common providers. */
export const STARTER_CONFIG: RouterConfig = {
  enabled: true,
  mode: "auto",
  defaultRoute: "implement",
  switchThreshold: 0.6,
  suggestThreshold: 0.35,
  minDwellTurns: 2,
  toolWindow: 6,
  pinReleasesOnPhaseChange: false,
  notify: "min",
  footer: true,
  log: true,
  guard: { interactiveOnly: true, disableInSubagents: true },
  llm: {
    enabled: true,
    model: "openai-codex/gpt-5.4-mini",
    timeoutMs: 2500,
    deadbandLow: 0.2,
    deadbandHigh: 0.6,
  },
  budget: {
    enabled: true,
    maxSessionUsd: 5.0,
    warnAtPercent: 0.8,
  },
  calibration: { enabled: true, rate: 0.05, maxAdjust: 0.3 },
  runtimeFallback: { enabled: true, maxAttemptsPerTurn: 2, cooldownMs: 300_000 },
  // Per-model "similar model" chains, tried in order when a model errors or is in
  // cooldown. Unregistered / unauthenticated entries are skipped automatically,
  // so listing a model you have not configured (e.g. kimi) is harmless.
  modelFallbacks: {
    "cursor/composer-2.5:fast": ["opencode-go/kimi-k2.7-code", "openai-codex/gpt-5.4-mini", "anthropic/claude-sonnet-4-6"],
    "cursor/composer-2.5": ["opencode-go/kimi-k2.7-code", "openai-codex/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    "openai-codex/gpt-5.5": ["anthropic/claude-sonnet-4-6", "opencode-go/kimi-k2.7-code", "openai-codex/gpt-5.4"],
    "openai-codex/gpt-5.4-mini": ["openai-codex/gpt-5.4", "opencode-go/kimi-k2.7-code", "anthropic/claude-sonnet-4-6"],
    "anthropic/claude-sonnet-4-6": ["openai-codex/gpt-5.5", "opencode-go/kimi-k2.7-code", "cursor/composer-2.5:fast"],
    "anthropic/claude-opus-4-8": ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.5"],
  },
  weights: { ...DEFAULT_WEIGHTS },
  lexicon: structuredCloneSafe(DEFAULT_LEXICON),
  rules: [
    { match: ["production", "deploy", "release"], route: "review", reason: "Safety on prod-touching work" },
  ],
  routes: {
    investigate: {
      model: "cursor/composer-2.5:fast",
      thinkingLevel: "off",
      tools: ["read", "bash", "grep", "find", "ls"],
    },
    plan: {
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "high",
      tools: ["read", "grep", "find", "ls"],
      instructions:
        "You are in PLANNING MODE. Do not edit or write files. Read in full, explore the codebase, ask clarifying questions, then produce a phased plan with risks and the exact files to change.",
    },
    implement: {
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    },
    review: {
      model: "anthropic/claude-opus-4-8",
      thinkingLevel: "high",
      tools: ["read", "bash", "grep", "find", "ls"],
      requiresVision: true,
      instructions:
        "You are reviewing. Focus on correctness, regressions, tests, security, and architecture boundaries. Do not modify files.",
    },
    debug: {
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "xhigh",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    },
  },
};

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function globalConfigPath(): string {
  return join(getAgentDir(), "model-router.json");
}

function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "model-router.json");
}

/** Result of a load: the effective config plus any human-readable warnings. */
export interface LoadResult {
  config: RouterConfig;
  warnings: string[];
  /** Combined mtime fingerprint for cheap hot-reload checks. */
  fingerprint: string;
}

function mtimeOf(path: string): number {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  } catch {
    return 0;
  }
}

/** Cheap fingerprint of both config files for hot-reload detection. */
export function configFingerprint(cwd: string): string {
  return `${mtimeOf(globalConfigPath())}:${mtimeOf(projectConfigPath(cwd))}`;
}

/** Ensure the global starter config exists. No-op if already present. */
export function ensureStarterConfig(): void {
  const path = globalConfigPath();
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, "utf8");
  } catch {
    // Non-fatal: router still runs from in-memory defaults.
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Deep-merge `override` onto `base`. Objects merge by key; arrays replace. */
function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const prev = (base as any)?.[key];
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      prev && typeof prev === "object" && !Array.isArray(prev)
    ) {
      out[key] = deepMerge(prev, value as any);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Clamp a number into [0,1]; return fallback when not finite. */
function clamp01(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * Load, merge, and validate config. Never throws — returns the last-known-good
 * (or starter) config plus warnings on any problem.
 */
export function loadConfig(cwd: string, lastGood?: RouterConfig): LoadResult {
  const warnings: string[] = [];
  let merged: RouterConfig = structuredCloneSafe(lastGood ?? STARTER_CONFIG);

  try {
    const global = readJson(globalConfigPath());
    const project = readJson(projectConfigPath(cwd));
    // Start from starter so missing keys always have sane defaults.
    merged = deepMerge(structuredCloneSafe(STARTER_CONFIG), global as Partial<RouterConfig>);
    if (project) {
      // Project routes/rules are additive-friendly: routes merge by key, rules concat.
      const projectTyped = project as Partial<RouterConfig>;
      merged = deepMerge(merged, projectTyped);
      if (Array.isArray((global as any)?.rules) || Array.isArray(projectTyped.rules)) {
        merged.rules = [
          ...(((project as any)?.rules as any[]) ?? []),
          ...(((global as any)?.rules as any[]) ?? STARTER_CONFIG.rules),
        ];
      }
    }
  } catch (err) {
    warnings.push(`model-router: config parse error (${(err as Error).message}); using last good config.`);
    return { config: structuredCloneSafe(lastGood ?? STARTER_CONFIG), warnings, fingerprint: configFingerprint(cwd) };
  }

  // Normalize / validate numeric fields.
  merged.switchThreshold = clamp01(merged.switchThreshold, 0.6);
  merged.suggestThreshold = clamp01(merged.suggestThreshold, 0.35);
  if (merged.suggestThreshold > merged.switchThreshold) {
    merged.suggestThreshold = merged.switchThreshold;
  }
  merged.minDwellTurns = Math.max(0, Math.floor(Number(merged.minDwellTurns) || 0));
  merged.toolWindow = Math.max(1, Math.floor(Number(merged.toolWindow) || 6));

  // Validate routes exist and defaultRoute is real.
  if (!merged.routes || Object.keys(merged.routes).length === 0) {
    warnings.push("model-router: no routes configured; falling back to starter routes.");
    merged.routes = structuredCloneSafe(STARTER_CONFIG.routes);
  }
  if (!merged.routes[merged.defaultRoute]) {
    const first = Object.keys(merged.routes)[0]!;
    warnings.push(`model-router: defaultRoute "${merged.defaultRoute}" not found; using "${first}".`);
    merged.defaultRoute = first;
  }

  // Ensure lexicon/weights are at least the defaults plus any user additions.
  merged.lexicon = { ...DEFAULT_LEXICON, ...(merged.lexicon ?? {}) };
  merged.weights = { ...DEFAULT_WEIGHTS, ...(merged.weights ?? {}) };

  return { config: merged, warnings, fingerprint: configFingerprint(cwd) };
}

/** Parse "provider/model-id" into parts. Keeps ":variant" / "@ctx" on the id. */
export function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx === ref.length - 1) return undefined;
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** Find the cheapest configured route by a rough heuristic (used for budget downgrade). */
export function cheapestRoute(config: RouterConfig): Phase {
  // Prefer an explicit downgradeRoute, else a route literally named for speed,
  // else the defaultRoute. We do not have per-route cost here, so we rely on
  // config intent rather than guessing.
  if (config.budget.downgradeRoute && config.routes[config.budget.downgradeRoute]) {
    return config.budget.downgradeRoute;
  }
  const named = Object.keys(config.routes).find((r) => /invest|cheap|fast|quick/i.test(r));
  return named ?? config.defaultRoute;
}

export { DEFAULT_LEXICON, DEFAULT_WEIGHTS };
export type { RouteConfig };
