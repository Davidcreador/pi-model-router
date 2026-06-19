/**
 * Runtime state store for the router.
 *
 * Holds the live phase/pin/cost plus a rolling tool-usage window and an undo
 * stack. Persistence is delegated to the caller (index.ts) via
 * `pi.appendEntry` / session entry restore, but the (de)serialization helpers
 * live here so the shape stays in one place.
 */

import type { Decision, PersistedState, Phase, RouterConfig } from "./types.ts";

export interface UndoEntry {
  phase: Phase;
  modelKey: string | undefined;
}

export class RouterStore {
  /** Current active phase. */
  phase: Phase;
  /** Manual pin: when true, auto-routing is paused until cleared. */
  pinned = false;
  /** "provider/id" of the pinned model, for status display. */
  pinnedModelKey: string | undefined;
  /** Turns elapsed since the last phase switch (drives min-dwell hysteresis). */
  turnsSinceSwitch = 999;
  /** Accumulated session cost (USD) for the budget guard. */
  sessionCostUsd = 0;
  /** True once the budget warning has fired (warn-once). */
  budgetWarned = false;
  /** True once over-budget downgrade has been decided (cost crossed the cap). */
  budgetDowngraded = false;
  /** True once the over-budget pin has actually been applied (apply once, not per turn). */
  budgetPinApplied = false;
  /** Rolling window of recent tool names (most recent last). */
  toolWindow: string[] = [];
  /** Last decision, surfaced by `/route explain` and the footer. */
  lastDecision: Decision | undefined;
  /** Undo stack for `/route undo`. */
  undoStack: UndoEntry[] = [];
  /** Internal flag: set true while the router itself calls setModel, so the
   *  model_select handler does not mistake it for a manual pin. */
  routerSwitching = false;

  // ─── runtime provider-error fallback ───────────────────────────────────
  /** modelKey -> unix-ms expiry; while in the future the model is skipped. */
  unhealthyModels = new Map<string, number>();
  /** Last genuine user prompt, replayed when we hop to a fallback model. */
  lastUserText = "";
  /** Images from the last genuine user prompt (replayed with the text). */
  lastUserImages: unknown[] | undefined;
  /** Fallback hops used within the current user request. */
  fallbackAttempts = 0;
  /** Model keys already tried for the current request (avoid loops). */
  attemptedModels = new Set<string>();
  /** True between a fallback switch and its replayed turn, so we don't re-route it. */
  pendingResubmit = false;
  /** Suppress duplicate warnings within a session, keyed by reason. */
  private warnedKeys = new Set<string>();

  constructor(defaultRoute: Phase) {
    this.phase = defaultRoute;
  }

  /** Mark a model unhealthy for `cooldownMs`. */
  markUnhealthy(modelKey: string, cooldownMs: number): void {
    if (!modelKey) return;
    this.unhealthyModels.set(modelKey, Date.now() + Math.max(0, cooldownMs));
  }

  /** Healthy = not in cooldown. Expired entries are cleaned lazily. */
  isHealthy(modelKey: string): boolean {
    const expiry = this.unhealthyModels.get(modelKey);
    if (expiry === undefined) return true;
    if (Date.now() >= expiry) {
      this.unhealthyModels.delete(modelKey);
      return true;
    }
    return false;
  }

  /** Reset per-request fallback bookkeeping when a fresh user prompt arrives. */
  resetTurnFallback(): void {
    this.fallbackAttempts = 0;
    this.attemptedModels.clear();
  }

  pushTool(name: string, windowSize: number): void {
    this.toolWindow.push(name);
    if (this.toolWindow.length > windowSize) {
      this.toolWindow.splice(0, this.toolWindow.length - windowSize);
    }
  }

  /** Return true the first time a given warning key is seen this session. */
  shouldWarn(key: string): boolean {
    if (this.warnedKeys.has(key)) return false;
    this.warnedKeys.add(key);
    return true;
  }

  resetWarnings(): void {
    this.warnedKeys.clear();
  }

  toPersisted(): PersistedState {
    return {
      phase: this.phase,
      pinned: this.pinned,
      pinnedModelKey: this.pinnedModelKey,
      sessionCostUsd: this.sessionCostUsd,
    };
  }

  applyPersisted(p: PersistedState | undefined, config: RouterConfig): void {
    if (!p) return;
    if (p.phase && config.routes[p.phase]) this.phase = p.phase;
    this.pinned = !!p.pinned;
    this.pinnedModelKey = p.pinnedModelKey;
    if (typeof p.sessionCostUsd === "number") this.sessionCostUsd = p.sessionCostUsd;
  }
}
