/**
 * Switch policy: hybrid-by-confidence + sticky phases + pin precedence.
 *
 * Pure decision logic over (classification, store, config). Returns the action
 * to take and the target phase; the caller (index.ts) performs the side effects.
 */

import type { Classification, DecisionAction, Phase, RouterConfig } from "./types.ts";
import type { RouterStore } from "./state.ts";

export interface PolicyResult {
  action: DecisionAction;
  targetPhase: Phase;
  reason: string;
}

/**
 * Decide what to do for this turn.
 *
 * Precedence:
 *   1. mode off        → "off"
 *   2. pinned          → "pinned" (no auto switching)
 *   3. same phase      → "stay" (tools/thinking refresh handled by caller)
 *   4. hard signal     → "switch" (bypasses dwell)
 *   5. below dwell     → "stay"/"suggest" (anti-flap) unless very confident
 *   6. >= switchThresh → "switch"
 *   7. >= suggestThresh→ "suggest"
 *   8. else            → "stay"
 */
export function decide(
  cls: Classification,
  store: RouterStore,
  config: RouterConfig,
): PolicyResult {
  if (config.mode === "off") {
    return { action: "off", targetPhase: store.phase, reason: "router off" };
  }

  if (store.pinned) {
    return { action: "pinned", targetPhase: store.phase, reason: "manual pin active" };
  }

  const target = cls.phase;
  const isHard = cls.source === "hard";

  if (target === store.phase) {
    return { action: "stay", targetPhase: store.phase, reason: "already in phase" };
  }

  // Suggest mode never auto-switches (hard signals still only suggest).
  if (config.mode === "suggest") {
    if (cls.confidence >= config.suggestThreshold) {
      return { action: "suggest", targetPhase: target, reason: "suggest mode" };
    }
    return { action: "stay", targetPhase: store.phase, reason: "low confidence" };
  }

  // Hard signals bypass dwell/hysteresis entirely.
  if (isHard) {
    return { action: "switch", targetPhase: target, reason: `hard signal (${cls.signals.join(",")})` };
  }

  // Anti-flap: within the dwell window, require near-certainty to switch.
  if (store.turnsSinceSwitch < config.minDwellTurns && cls.confidence < 0.9) {
    if (cls.confidence >= config.suggestThreshold) {
      return { action: "suggest", targetPhase: target, reason: "within dwell window" };
    }
    return { action: "stay", targetPhase: store.phase, reason: "within dwell window" };
  }

  if (cls.confidence >= config.switchThreshold) {
    return { action: "switch", targetPhase: target, reason: `confidence ${cls.confidence.toFixed(2)}` };
  }
  if (cls.confidence >= config.suggestThreshold) {
    return { action: "suggest", targetPhase: target, reason: `confidence ${cls.confidence.toFixed(2)}` };
  }
  return { action: "stay", targetPhase: store.phase, reason: "low confidence" };
}
