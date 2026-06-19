/**
 * Classification: turn signals into a phase + confidence.
 *
 * Tier order (see SPEC §5):
 *   - hard signal      → that phase, confidence 1.0
 *   - heuristic score  → margin-based confidence
 *   - LLM tiebreak     → only when heuristic lands in the dead-band (lib/llm.ts)
 *
 * Confidence is the normalized margin between the top phase and the runner-up,
 * floored by the absolute winning score. Two close phases ⇒ low confidence ⇒
 * the policy layer suggests instead of switching.
 */

import type { Classification, Phase, RouterConfig, Signal } from "./types.ts";

/** Aggregate signals into per-phase scores. */
export function scorePhases(signals: Signal[], phases: Phase[]): Record<Phase, number> {
  const scores: Record<Phase, number> = {};
  for (const p of phases) scores[p] = 0;
  for (const s of signals) {
    if (scores[s.phase] === undefined) scores[s.phase] = 0;
    scores[s.phase] += s.weight;
  }
  return scores;
}

function argmax(scores: Record<Phase, number>): { phase: Phase; value: number } {
  let best: Phase | undefined;
  let bestVal = -Infinity;
  for (const [phase, value] of Object.entries(scores)) {
    if (value > bestVal) {
      bestVal = value;
      best = phase;
    }
  }
  return { phase: best ?? Object.keys(scores)[0]!, value: bestVal === -Infinity ? 0 : bestVal };
}

function runnerUp(scores: Record<Phase, number>, winner: Phase): number {
  let second = 0;
  for (const [phase, value] of Object.entries(scores)) {
    if (phase === winner) continue;
    if (value > second) second = value;
  }
  return second;
}

/**
 * Heuristic classification. Returns the winning phase, a margin-based
 * confidence in [0,1], the raw scores, the fired signal ids, and whether the
 * result is "ambiguous" (in the configured LLM dead-band).
 */
export function classifyHeuristic(signals: Signal[], config: RouterConfig): Classification {
  const phases = Object.keys(config.routes);
  const scores = scorePhases(signals, phases);

  const hard = signals.find((s) => s.hard);
  const win = argmax(scores);

  // No signal fired at all.
  if (win.value <= 0) {
    return {
      phase: config.defaultRoute,
      confidence: 0,
      scores,
      signals: [],
      ambiguous: false,
      source: "none",
    };
  }

  const second = runnerUp(scores, win.phase);
  // Margin-based confidence: clear winner ⇒ high; near-tie ⇒ low.
  const margin = (win.value - second) / Math.max(win.value, 0.001);
  // Absolute-score floor so a single weak verb does not read as "certain".
  const absFloor = Math.min(win.value / 1.2, 1);
  let confidence = Math.max(0, Math.min(1, margin * 0.7 + absFloor * 0.3));

  // A hard signal short-circuits to full confidence on its phase.
  const isHardWinner = hard && hard.phase === win.phase;
  if (isHardWinner) confidence = 1;

  const ambiguous =
    !isHardWinner &&
    confidence >= config.llm.deadbandLow &&
    confidence < config.llm.deadbandHigh;

  return {
    phase: win.phase,
    confidence,
    scores,
    signals: dedupe(signals.map((s) => s.id)),
    ambiguous,
    source: isHardWinner ? "hard" : signals.some((s) => s.id.startsWith("rule:")) ? "rule" : "heuristic",
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
