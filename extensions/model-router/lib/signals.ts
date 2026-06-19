/**
 * Signal extraction.
 *
 * Pure functions over (prompt text, tool window, context usage, config). No Pi
 * APIs, no IO — so this module is trivially unit-testable with a table of
 * prompts. Each extractor returns zero or more weighted votes; hard signals
 * (diff/stacktrace/image/slash) are marked so the policy layer can bypass
 * hysteresis for them.
 */

import type { Phase, RouterConfig, Signal } from "./types.ts";

/** Recognized slash-route prefix, e.g. "/route plan ...". Returns the phase. */
export function parseSlashRoute(text: string, routes: Record<Phase, unknown>): Phase | undefined {
  const m = text.trim().match(/^\/route\s+([a-z0-9_-]+)/i);
  if (!m) return undefined;
  const phase = m[1]!.toLowerCase();
  return routes[phase] ? phase : undefined;
}

const DIFF_RE = /\b(pull request|pr\s*#?\d|git diff|the diff|this diff|merge request|mr\s*#?\d|code review|review (this|the|my))\b/i;
const STACKTRACE_RE = /(traceback \(most recent call last\)|^\s*at\s+[\w$.<>]+\s*\(|Exception in thread|\b[A-Z]\w*Error:|\bpanic:|\bunhandled exception\b|\bsegmentation fault\b)/im;
const SPEED_RE = /\b(quick(ly)?|just|fast|simple|tiny|trivial|one-liner|asap)\b/i;
const DEPTH_RE = /\b(carefully|thorough(ly)?|deep(ly)?|think hard|rigorous|edge cases?|exhaustive|step by step)\b/i;
const QUESTION_RE = /^\s*(what|why|how|where|which|who|when|is|are|does|do|can|could|should)\b.*\?|.*\?\s*$/i;
const COMMAND_RE = /^\s*(add|create|implement|write|fix|refactor|change|update|rename|remove|delete|migrate|build|make|wire|hook)\b/i;

/** Tools that imply read-only investigation vs. mutation. */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

export interface SignalInput {
  text: string;
  hasImage: boolean;
  /** Most-recent-last list of recent tool names. */
  toolWindow: string[];
}

function w(config: RouterConfig, id: string, fallback: number): number {
  const v = config.weights[id];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Whole-word (or whole-phrase) match. Critical for routing quality: a substring
 * test wrongly fires "add" inside "adding" and "read" inside "already", which
 * inflates false votes and drags confidence below the switch threshold. Word
 * boundaries keep votes honest and let clear prompts win decisively.
 */
function hasWord(haystackLower: string, needleLower: string): boolean {
  const trimmed = needleLower.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(haystackLower);
  } catch {
    return haystackLower.includes(trimmed);
  }
}

/**
 * Extract weighted signals. `calibration` is an optional per-(signal,phase)
 * additive nudge map produced by the calibration module.
 */
export function extractSignals(
  input: SignalInput,
  config: RouterConfig,
  calibration?: Record<string, number>,
): Signal[] {
  const out: Signal[] = [];
  const text = input.text ?? "";
  const lower = text.toLowerCase();
  const phases = Object.keys(config.routes);

  const nudge = (signalId: string, phase: Phase): number =>
    calibration?.[`${signalId}:${phase}`] ?? 0;

  // ---- Hard signals (Tier 1) -------------------------------------------
  if (input.hasImage) {
    // Vision need is handled at apply time; we still vote so review/investigate
    // do not wrongly win on text alone. Phase chosen by apply's vision pick.
    out.push({ id: "image", phase: config.defaultRoute, weight: w(config, "image", 0.8), hard: true });
  }
  if (DIFF_RE.test(text) && config.routes["review"]) {
    out.push({ id: "diff", phase: "review", weight: w(config, "diff", 0.8), hard: true });
  }
  if (STACKTRACE_RE.test(text) && config.routes["debug"]) {
    out.push({ id: "stacktrace", phase: "debug", weight: w(config, "stacktrace", 0.8), hard: true });
  }

  // ---- Config rules (very strong soft signal) ---------------------------
  for (const rule of config.rules ?? []) {
    if (!config.routes[rule.route]) continue;
    const needles = Array.isArray(rule.match) ? rule.match : [rule.match];
    if (needles.some((n) => n && lower.includes(String(n).toLowerCase()))) {
      out.push({ id: `rule:${rule.route}`, phase: rule.route, weight: w(config, "rule", 0.9) });
    }
  }

  // ---- Verb lexicon -----------------------------------------------------
  for (const phase of phases) {
    const words = config.lexicon[phase] ?? [];
    let hits = 0;
    for (const word of words) {
      if (word && hasWord(lower, word.toLowerCase())) hits++;
    }
    if (hits > 0) {
      // Diminishing returns: 1 hit full weight, extra hits add 50% each, capped.
      const base = w(config, "verb", 0.45);
      const weight = Math.min(base * (1 + 0.5 * (hits - 1)), base * 2);
      out.push({ id: "verb", phase, weight: weight + nudge("verb", phase) });
    }
  }

  // ---- Question vs command shape ---------------------------------------
  if (QUESTION_RE.test(text)) {
    const qw = w(config, "question-shape", 0.2);
    if (config.routes["investigate"]) out.push({ id: "question-shape", phase: "investigate", weight: qw });
    if (config.routes["plan"]) out.push({ id: "question-shape", phase: "plan", weight: qw * 0.6 });
  }
  if (COMMAND_RE.test(text) && config.routes["implement"]) {
    out.push({ id: "command-shape", phase: "implement", weight: w(config, "command-shape", 0.2) });
  }

  // ---- Recent tool-usage window ----------------------------------------
  if (input.toolWindow.length > 0) {
    let reads = 0;
    let writes = 0;
    for (const t of input.toolWindow) {
      if (READ_TOOLS.has(t)) reads++;
      else if (WRITE_TOOLS.has(t)) writes++;
    }
    const total = input.toolWindow.length;
    const tw = w(config, "tools", 0.3);
    if (writes > 0 && config.routes["implement"]) {
      out.push({ id: "tools", phase: "implement", weight: tw * (writes / total) });
    }
    if (reads > writes && config.routes["investigate"]) {
      out.push({ id: "tools", phase: "investigate", weight: tw * (reads / total) });
    }
  }

  // ---- Speed / depth modifiers (do not create a phase; bias thinking) ---
  // These are surfaced as signals so policy/apply can adjust thinking, but they
  // vote weakly toward fast (investigate/implement) vs deliberate (plan/review).
  if (SPEED_RE.test(text)) {
    const sw = w(config, "speed-word", 0.25);
    if (config.routes["implement"]) out.push({ id: "speed-word", phase: "implement", weight: sw * 0.5 });
    if (config.routes["investigate"]) out.push({ id: "speed-word", phase: "investigate", weight: sw * 0.5 });
  }
  if (DEPTH_RE.test(text)) {
    const dw = w(config, "depth-word", 0.25);
    if (config.routes["plan"]) out.push({ id: "depth-word", phase: "plan", weight: dw * 0.5 });
    if (config.routes["review"]) out.push({ id: "depth-word", phase: "review", weight: dw * 0.5 });
  }

  return out;
}

/** True when the prompt carries a speed cue (used by apply for thinking bias). */
export function wantsSpeed(text: string): boolean {
  return SPEED_RE.test(text ?? "");
}

/** True when the prompt carries a depth cue. */
export function wantsDepth(text: string): boolean {
  return DEPTH_RE.test(text ?? "");
}
