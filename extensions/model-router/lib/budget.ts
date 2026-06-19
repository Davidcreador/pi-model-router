/**
 * Session cost guard.
 *
 * Accumulates assistant-message cost and, when over the configured cap, forces
 * the router onto the cheapest route. Warns once at `warnAtPercent`. Pure state
 * mutation + a small report struct; the caller applies the downgrade.
 */

import { cheapestRoute } from "./config.ts";
import type { RouterStore } from "./state.ts";
import type { Phase, RouterConfig } from "./types.ts";

export interface BudgetReport {
  /** Force the router to this route (over-budget downgrade). */
  forceRoute?: Phase;
  /** One-line warning to surface (warn-once). */
  warning?: string;
}

/** Record a message's cost. Returns instructions for the caller. */
export function recordCost(
  costUsd: number,
  store: RouterStore,
  config: RouterConfig,
): BudgetReport {
  if (!config.budget.enabled || config.budget.maxSessionUsd <= 0) return {};
  if (Number.isFinite(costUsd) && costUsd > 0) store.sessionCostUsd += costUsd;

  const cap = config.budget.maxSessionUsd;
  const spent = store.sessionCostUsd;
  const report: BudgetReport = {};

  // Warn once when crossing the warn threshold.
  if (!store.budgetWarned && spent >= cap * config.budget.warnAtPercent) {
    store.budgetWarned = true;
    report.warning = `model-router: session spend $${spent.toFixed(2)} of $${cap.toFixed(2)} budget`;
  }

  // Downgrade once when over the cap.
  if (!store.budgetDowngraded && spent >= cap) {
    store.budgetDowngraded = true;
    const cheap = cheapestRoute(config);
    report.forceRoute = cheap;
    report.warning = `model-router: over $${cap.toFixed(2)} budget — pinning cheapest route "${cheap}"`;
  }

  return report;
}
