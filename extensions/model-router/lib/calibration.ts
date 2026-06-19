/**
 * Correction learning.
 *
 * When the user overrides the router (manual pin, `/route undo`, or an explicit
 * `/route <phase>` right after an auto switch), we nudge the weights of the
 * signals that fired on the previous decision toward the phase the user
 * actually wanted, and away from the phase the router picked. Nudges are small,
 * clamped, and persisted to disk so they accumulate across sessions.
 *
 * Storage: ~/.pi/agent/model-router/calibration.json
 *   { "<signalId>:<phase>": <additiveNudge>, ... }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Decision, Phase, RouterConfig } from "./types.ts";

function calibrationPath(): string {
  return join(getAgentDir(), "model-router", "calibration.json");
}

export type CalibrationMap = Record<string, number>;

export function loadCalibration(): CalibrationMap {
  try {
    const path = calibrationPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as CalibrationMap;
  } catch {
    return {};
  }
}

function save(map: CalibrationMap): void {
  try {
    const path = calibrationPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  } catch {
    // Non-fatal: calibration is best-effort.
  }
}

function clampNudge(value: number, max: number): number {
  return Math.max(-max, Math.min(max, value));
}

/**
 * Apply a correction: the user wanted `correctedPhase` but the previous
 * decision chose `decision.phaseTo`. Nudge each fired signal's weight toward
 * the corrected phase and away from the wrong one. Mutates and persists `map`.
 */
export function applyCorrection(
  map: CalibrationMap,
  decision: Decision,
  correctedPhase: Phase,
  config: RouterConfig,
): void {
  if (!config.calibration.enabled) return;
  if (!decision || correctedPhase === decision.phaseTo) return;

  const rate = config.calibration.rate;
  const maxAdjust = config.calibration.maxAdjust;

  for (const sigId of decision.signals) {
    // Skip non-weight signals (llm, hard one-offs) — only verb/tools/shape learn.
    if (!/^(verb|tools|question-shape|command-shape|speed-word|depth-word)$/.test(sigId)) continue;

    const upKey = `${sigId}:${correctedPhase}`;
    const downKey = `${sigId}:${decision.phaseTo}`;
    map[upKey] = clampNudge((map[upKey] ?? 0) + rate, maxAdjust);
    map[downKey] = clampNudge((map[downKey] ?? 0) - rate, maxAdjust);
  }
  save(map);
}

/** Reset all learned calibration. */
export function resetCalibration(): CalibrationMap {
  const empty: CalibrationMap = {};
  save(empty);
  return empty;
}
