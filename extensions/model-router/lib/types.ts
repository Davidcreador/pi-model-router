/**
 * Shared types for the model-router extension.
 *
 * Kept dependency-light: only pulls Pi's ThinkingLevel union so config and
 * runtime state stay aligned with what `pi.setThinkingLevel` accepts.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Speed lane. A convenience that resolves to a model variant + thinking. */
export type Speed = "fast" | "balanced" | "slow";

/** Router operating mode. */
export type RouterMode = "auto" | "suggest" | "off";

/** A phase/route key (e.g. "implement"). Phase and route names are 1:1. */
export type Phase = string;

/** Concrete config bound to a phase. */
export interface RouteConfig {
  /** "provider/model-id" — id may include cursor variant suffixes like ":fast" or "@1m". */
  model: string;
  /** Reasoning level. Clamped to model capabilities at apply time. */
  thinkingLevel?: ThinkingLevel;
  /** Active tool allowlist while this route is active. Omit to keep current tools. */
  tools?: string[];
  /** Appended to the system prompt while this route is active. */
  instructions?: string;
  /** Mark routes whose model accepts image input (used for image-prompt fallback). */
  requiresVision?: boolean;
  /** Optional speed lane; resolves to a model variant + thinking when set. */
  speed?: Speed;
  /** Ordered alternative model ids tried (in order) when this route's model errors or is unhealthy. */
  fallbacks?: string[];
}

/** Keyword rule that force-selects a route. Highest-priority soft signal. */
export interface Rule {
  match: string | string[];
  route: Phase;
  reason?: string;
}

/** Optional LLM tiebreak classifier (Tier 3). */
export interface LlmConfig {
  /** Master switch. When false, only heuristics run. */
  enabled: boolean;
  /** "provider/model-id" of a cheap, fast model. Falls back to heuristics if unresolved. */
  model?: string;
  /** Hard timeout for the classification call. */
  timeoutMs: number;
  /** Only invoke the LLM when heuristic confidence is within [deadbandLow, deadbandHigh). */
  deadbandLow: number;
  deadbandHigh: number;
}

/** Session cost guard. */
export interface BudgetConfig {
  enabled: boolean;
  /** Max session spend in USD before downgrade kicks in. 0 disables the cap. */
  maxSessionUsd: number;
  /** Route to force when over budget. Defaults to the cheapest configured route. */
  downgradeRoute?: Phase;
  /** Warn once when spend crosses this fraction of the cap (0..1). */
  warnAtPercent: number;
}

/** Correction-learning. Nudges signal weights from user overrides. */
export interface CalibrationConfig {
  enabled: boolean;
  /** Per-correction weight nudge. */
  rate: number;
  /** Clamp on accumulated nudge magnitude. */
  maxAdjust: number;
}

/** Where auto-routing is allowed to run. */
export interface GuardConfig {
  interactiveOnly: boolean;
  disableInSubagents: boolean;
}

/** Runtime provider-error fallback: when a model errors mid-turn, switch to a similar one. */
export interface RuntimeFallbackConfig {
  /** Master switch. */
  enabled: boolean;
  /** How many times to retry the SAME model (replay the prompt) before
   *  switching to a fallback. Connection errors are transient; retrying the
   *  same model avoids needless model hopping. */
  retryAttempts: number;
  /** Max fallback hops (model switches) within a single user request before giving up. */
  maxAttemptsPerTurn: number;
  /** How long a failed model is treated as unhealthy and skipped (ms). */
  cooldownMs: number;
}

export interface RouterConfig {
  enabled: boolean;
  mode: RouterMode;
  defaultRoute: Phase;
  /** Auto-switch when confidence >= this. */
  switchThreshold: number;
  /** Suggest (no switch) when confidence in [suggestThreshold, switchThreshold). */
  suggestThreshold: number;
  /** Turns to hold a phase before a soft re-switch is allowed. */
  minDwellTurns: number;
  /** How many recent tool calls feed the tool-usage signal. */
  toolWindow: number;
  /** Locked: manual pin stays until explicitly cleared. */
  pinReleasesOnPhaseChange: boolean;
  routes: Record<Phase, RouteConfig>;
  rules: Rule[];
  /** Override / extend the verb lexicon per phase. */
  lexicon: Record<Phase, string[]>;
  /** Override individual signal weights by signal id. */
  weights: Record<string, number>;
  notify: "min" | "verbose" | "off";
  footer: boolean;
  log: boolean;
  guard: GuardConfig;
  llm: LlmConfig;
  budget: BudgetConfig;
  calibration: CalibrationConfig;
  runtimeFallback: RuntimeFallbackConfig;
  /** Per-model ordered alternatives ("provider/id" -> ["provider/id", ...]). Applied on error/unhealthy. */
  modelFallbacks: Record<string, string[]>;
}

/** A single fired signal contributing a weighted vote. */
export interface Signal {
  id: string;
  phase: Phase;
  weight: number;
  /** True for Tier-1 hard signals that bypass dwell/hysteresis. */
  hard?: boolean;
}

/** Result of classification for one prompt. */
export interface Classification {
  phase: Phase;
  confidence: number;
  scores: Record<Phase, number>;
  signals: string[];
  /** Heuristic landed in the LLM dead-band. */
  ambiguous: boolean;
  /** "heuristic" | "llm" | "rule" | "hard". */
  source: string;
}

export type DecisionAction =
  | "switch"
  | "suggest"
  | "stay"
  | "pinned"
  | "forced"
  | "fallback"
  | "off";

/** A logged routing decision. */
export interface Decision {
  ts: string;
  phaseFrom: Phase;
  phaseTo: Phase;
  action: DecisionAction;
  confidence: number;
  scores: Record<Phase, number>;
  signals: string[];
  model?: string;
  thinking?: ThinkingLevel;
  source: string;
  reason?: string;
}

/** Persisted-per-session router state snapshot. */
export interface PersistedState {
  phase: Phase;
  pinned: boolean;
  pinnedModelKey?: string;
  sessionCostUsd?: number;
}
