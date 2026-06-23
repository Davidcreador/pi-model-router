/**
 * model-router — dynamic, task-phase model routing for pi.
 *
 * Wires the pipeline:
 *   input → signals → classify (heuristic [+ LLM tiebreak]) → policy → apply
 * with sticky phases, hybrid-confidence UX, manual pin, calibration learning,
 * a session budget guard, persistence, and a `/route` command surface.
 *
 * Design + rationale: see SPEC.md in this directory.
 *
 * Single interactive session per process, so module-level singletons are safe
 * (mirrors model-roster.ts / pi-working-vibe). Every handler is defensive: the
 * router must never throw out of an event or block/transform user input.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  InputEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
  loadConfig,
  configFingerprint,
  ensureStarterConfig,
  cheapestRoute,
} from "./lib/config.ts";
import { RouterStore } from "./lib/state.ts";
import { DecisionLog } from "./lib/log.ts";
import { extractSignals, wantsDepth, wantsSpeed } from "./lib/signals.ts";
import { classifyHeuristic } from "./lib/classifier.ts";
import { llmTiebreak } from "./lib/llm.ts";
import { decide } from "./lib/policy.ts";
import { applyRoute, pickFallbackForKey } from "./lib/apply.ts";
import { recordCost } from "./lib/budget.ts";
import {
  loadCalibration,
  applyCorrection,
  resetCalibration,
  type CalibrationMap,
} from "./lib/calibration.ts";
import { buildStatus } from "./lib/status.ts";
import { registerCommands, type Runtime } from "./lib/commands.ts";
import type {
  Decision,
  Phase,
  RouterConfig,
  RouterMode,
  ThinkingLevel,
} from "./lib/types.ts";

// ─── module state ─────────────────────────────────────────────────────────
let config: RouterConfig;
let store: RouterStore;
let log: DecisionLog;
let calibration: CalibrationMap = {};
let cwd = process.cwd();
let fingerprint = "";

/** Runtime overrides set via `/route` that must survive config hot-reload. */
const overrides: { mode?: RouterMode; llmEnabled?: boolean } = {};

// ─── helpers ──────────────────────────────────────────────────────────────

function applyOverrides(cfg: RouterConfig): void {
  if (overrides.mode) cfg.mode = overrides.mode;
  if (typeof overrides.llmEnabled === "boolean") cfg.llm.enabled = overrides.llmEnabled;
}

function currentModelKey(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
  const m = ctx.model;
  return m ? `${m.provider}/${m.id}` : undefined;
}

function toast(
  ctx: ExtensionContext | ExtensionCommandContext,
  text: string,
  level: "info" | "warning" | "error" = "info",
): void {
  try {
    ctx.ui.notify(text, level);
  } catch {
    /* notify may be unavailable in some modes */
  }
}

/** Update the footer status slot (key "route"); coexists with powerline. */
function refreshFooter(ctx: ExtensionContext | ExtensionCommandContext, suggestion?: string): void {
  if (!config.footer) {
    try { ctx.ui.setStatus("route", undefined); } catch { /* ignore */ }
    return;
  }
  try {
    ctx.ui.setStatus("route", buildStatus(store, config, currentModelKey(ctx), suggestion));
  } catch {
    /* ignore */
  }
}

/** Reload config when either config file changed on disk. */
function maybeReload(ctx: ExtensionContext | ExtensionCommandContext): string[] {
  const fp = configFingerprint(cwd);
  if (fp === fingerprint) return [];
  const res = loadConfig(cwd, config);
  config = res.config;
  applyOverrides(config);
  fingerprint = res.fingerprint;
  log.setEnabled(config.log);
  return res.warnings;
}

function persist(pi: ExtensionAPI): void {
  try {
    pi.appendEntry("model-router-state", store.toPersisted());
  } catch {
    /* persistence is best-effort */
  }
}

function buildDecision(
  from: Phase,
  to: Phase,
  action: Decision["action"],
  confidence: number,
  scores: Record<Phase, number>,
  signals: string[],
  source: string,
  reason: string,
  modelKey?: string,
  thinking?: ThinkingLevel,
): Decision {
  return {
    ts: new Date().toISOString(),
    phaseFrom: from,
    phaseTo: to,
    action,
    confidence: Number(confidence.toFixed(3)),
    scores,
    signals,
    source,
    reason,
    model: modelKey,
    thinking,
  };
}

// ─── runtime provider-error fallback ─────────────────────────────────────────

interface AgentMessageLike {
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Errors compaction should handle, not model fallback. */
function isContextOverflow(msg: string): boolean {
  return /context (window|length)|maximum context|too long|exceeds?\b.*context|prompt is too large/i.test(msg);
}

/**
 * Replay the last genuine user prompt. Used both for same-model retries and
 * fallback hops. Sets `pendingResubmit` so the replayed input is not re-routed.
 *
 * `deliverAs: "followUp"` queues the replay until the current (failed) turn
 * finishes. The runtime maps `deliverAs` to its internal `streamingBehavior`;
 * using the wrong name here was the root cause of the "Agent is already
 * processing" error. The action wrapper catches internal rejections itself and
 * emits them as `Extension "<runtime>" error`, so a try/catch at the call
 * site cannot intercept them — passing the correct option prevents the error.
 */
function replayPrompt(pi: ExtensionAPI, text: string): void {
  store.pendingResubmit = true;
  const images = (store.lastUserImages as Array<Record<string, unknown>> | undefined) ?? [];
  const content = images.length ? [{ type: "text", text }, ...images] : text;
  pi.sendUserMessage(content as never, { deliverAs: "followUp" } as never);
}

/**
 * On a terminal agent error (after Pi's own retries), first retry the SAME
 * model `retryAttempts` times (connection errors are often transient), then
 * mark it unhealthy, pick a similar available model, and replay the prompt.
 * Bounded by `retryAttempts` (same-model retries) + `maxAttemptsPerTurn`
 * (model switches) + an attempted-models set to avoid loops.
 */
async function handleRuntimeFallback(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: AgentMessageLike[],
): Promise<void> {
  if (!config.runtimeFallback.enabled) return;
  if (config.guard.interactiveOnly && ctx.mode !== "tui") return;

  const lastAssistant = [...(messages ?? [])].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant || lastAssistant.stopReason !== "error") return;
  const err = lastAssistant.errorMessage ?? "";
  if (isContextOverflow(err)) return; // compaction territory, not a model fault

  const failedKey =
    currentModelKey(ctx) ??
    (lastAssistant.provider && lastAssistant.model
      ? `${lastAssistant.provider}/${lastAssistant.model}`
      : undefined);
  if (!failedKey) return;

  const short = (k: string) => k.split("/").pop();
  const text = store.lastUserText;
  if (!text) {
    // No prompt captured (e.g. agent_end before any input) — can't replay.
    toast(ctx, `model-router: ${short(failedKey)} errored; no prompt to retry`, "warning");
    refreshFooter(ctx);
    return;
  }

  const maxRetries = config.runtimeFallback.retryAttempts;

  // Phase 1 — Retry the SAME model before switching.
  // Connection errors and transient provider hiccups often clear on retry.
  // This avoids needless model hopping that disrupts the user's workflow.
  if (store.sameModelRetries < maxRetries) {
    store.sameModelRetries++;
    toast(
      ctx,
      `model-router: ${short(failedKey)} errored, retrying (${store.sameModelRetries}/${maxRetries})`,
      "warning",
    );
    refreshFooter(ctx);
    replayPrompt(pi, text);
    return;
  }

  // Phase 2 — Same-model retries exhausted; switch to a fallback model.
  store.markUnhealthy(failedKey, config.runtimeFallback.cooldownMs);
  store.attemptedModels.add(failedKey);

  if (store.fallbackAttempts >= config.runtimeFallback.maxAttemptsPerTurn) {
    toast(
      ctx,
      `model-router: ${short(failedKey)} failed; all retries and fallbacks exhausted`,
      "warning",
    );
    refreshFooter(ctx);
    return;
  }

  const hasImage = !!(store.lastUserImages && (store.lastUserImages as unknown[]).length);
  const pick = pickFallbackForKey(ctx, config, store, failedKey, { hasImage, exclude: store.attemptedModels });
  if (!pick) {
    toast(ctx, `model-router: ${short(failedKey)} failed; no healthy fallback available`, "warning");
    refreshFooter(ctx);
    return;
  }

  store.fallbackAttempts++;
  store.attemptedModels.add(pick.key);
  store.sameModelRetries = 0; // new model gets its own retry budget
  store.routerSwitching = true;
  try {
    await pi.setModel(pick.model);
  } finally {
    store.routerSwitching = false;
  }
  store.pinnedModelKey = undefined; // a fallback hop is not a manual pin

  const d = buildDecision(
    store.phase, store.phase, "fallback", 1, {}, ["provider-error"], "runtime-fallback",
    `${failedKey} errored`, pick.key,
  );
  store.lastDecision = d;
  log.record(d);
  toast(
    ctx,
    `model-router: ${short(failedKey)} retries exhausted → switching to ${short(pick.key)}`,
    "warning",
  );
  refreshFooter(ctx);
  replayPrompt(pi, text);
}

// ─── core: process one user input ───────────────────────────────────────────

function eligible(ctx: ExtensionContext, event: InputEvent): boolean {
  if (!config.enabled) return false;
  if (config.guard.interactiveOnly && ctx.mode !== "tui") return false; // also excludes subagent print/rpc
  if (event.source === "extension") return false;
  if (event.streamingBehavior) return false; // queued mid-stream, not a fresh turn
  return true;
}

async function processInput(pi: ExtensionAPI, ctx: ExtensionContext, event: InputEvent): Promise<void> {
  for (const w of maybeReload(ctx)) toast(ctx, w, "warning");

  if (config.mode === "off") {
    refreshFooter(ctx);
    return;
  }

  // Over-budget: pin to the cheapest route ONCE, then behave like any manual
  // pin. The user can /route auto to knowingly override, or /route budget reset.
  // (Previously this re-forced every turn with no escape hatch.)
  if (store.budgetDowngraded && !store.budgetPinApplied && !store.pinned) {
    const cheap = cheapestRoute(config);
    const res = await applyRoute(pi, ctx, config, store, cheap, {});
    if (res.ok) {
      store.phase = res.phase;
      store.turnsSinceSwitch = 0;
      store.pinned = true;
      store.pinnedModelKey = res.modelKey;
      store.budgetPinApplied = true;
      const d = buildDecision(store.phase, res.phase, "forced", 1, {}, ["budget"], "budget", "over budget — pinned cheapest", res.modelKey, res.thinking);
      store.lastDecision = d;
      log.record(d);
      toast(ctx, `model-router: over budget — pinned ${res.phase} (/route auto to override)`, "warning");
    }
    refreshFooter(ctx);
    return;
  }

  if (store.pinned) {
    refreshFooter(ctx);
    return;
  }

  const text = event.text ?? "";
  const hasImage = !!event.images && event.images.length > 0;

  const signals = extractSignals(
    { text, hasImage, toolWindow: store.toolWindow },
    config,
    calibration,
  );

  let cls = classifyHeuristic(signals, config);
  if (cls.ambiguous && config.llm.enabled) {
    cls = await llmTiebreak(ctx, config, text, cls);
  }

  const policy = decide(cls, store, config);

  if (policy.action === "switch") {
    // Snapshot for undo before mutating.
    store.undoStack.push({ phase: store.phase, modelKey: currentModelKey(ctx) });
    if (store.undoStack.length > 20) store.undoStack.shift();

    const from = store.phase;
    const res = await applyRoute(pi, ctx, config, store, policy.targetPhase, {
      hasImage,
      speedBias: wantsSpeed(text),
      depthBias: wantsDepth(text),
    });
    if (res.ok) {
      store.phase = res.phase;
      store.turnsSinceSwitch = 0;
      const label = res.fellBackTo && res.fellBackTo !== policy.targetPhase
        ? `${policy.targetPhase}→${res.phase}`
        : res.phase;
      if (config.notify !== "off") {
        const extra = config.notify === "verbose" ? `  [${cls.signals.join(",")}]` : "";
        toast(ctx, `route → ${label} · ${res.modelKey?.split("/").pop()}${res.thinking ? ` · ${res.thinking}` : ""}${extra}`);
      }
      if (res.warning) toast(ctx, res.warning, "warning");
      const d = buildDecision(from, res.phase, "switch", cls.confidence, cls.scores, cls.signals, cls.source, policy.reason, res.modelKey, res.thinking);
      store.lastDecision = d;
      log.record(d);
    } else {
      if (res.warning) toast(ctx, res.warning, "warning");
      store.undoStack.pop(); // switch failed; discard snapshot
    }
    refreshFooter(ctx);
    return;
  }

  if (policy.action === "suggest") {
    if (config.notify === "verbose") {
      toast(ctx, `route hint: looks like ${policy.targetPhase} (/route ${policy.targetPhase})`);
    }
    const d = buildDecision(store.phase, policy.targetPhase, "suggest", cls.confidence, cls.scores, cls.signals, cls.source, policy.reason);
    store.lastDecision = d;
    log.record(d);
    refreshFooter(ctx, policy.targetPhase);
    return;
  }

  // stay / pinned / off
  const d = buildDecision(store.phase, store.phase, policy.action, cls.confidence, cls.scores, cls.signals, cls.source, policy.reason);
  store.lastDecision = d;
  if (cls.confidence > 0) log.record(d);
  refreshFooter(ctx);
}

// ─── Runtime for the command surface ─────────────────────────────────────────

function makeRuntime(pi: ExtensionAPI): Runtime {
  return {
    phases: () => Object.keys(config.routes),

    status: (ctx) => {
      const lines = [
        `Router: ${config.enabled ? config.mode : "disabled"}`,
        `Phase:  ${store.phase}${store.pinned ? " (PINNED)" : ""}`,
        `Model:  ${currentModelKey(ctx) ?? "—"}${store.lastDecision?.thinking ? ` · ${store.lastDecision.thinking}` : ""}`,
      ];
      if (config.budget.enabled && config.budget.maxSessionUsd > 0) {
        lines.push(`Budget: $${store.sessionCostUsd.toFixed(2)} / $${config.budget.maxSessionUsd.toFixed(2)}`);
      }
      lines.push(`LLM:    ${config.llm.enabled ? (config.llm.model ?? "on") : "off"}`);
      const now = Date.now();
      const unhealthy = [...store.unhealthyModels.entries()].filter(([, exp]) => exp > now).map(([k]) => k.split("/").pop());
      if (unhealthy.length) lines.push(`Unhealthy: ${unhealthy.join(", ")}`);
      if (store.lastDecision) {
        lines.push(`Last:   ${store.lastDecision.action} → ${store.lastDecision.phaseTo} (${store.lastDecision.reason})`);
      }
      return lines.join("\n");
    },

    setMode: async (ctx, mode) => {
      overrides.mode = mode;
      config.mode = mode;
      if (mode === "auto") {
        store.pinned = false;
        store.pinnedModelKey = undefined;
      }
      refreshFooter(ctx);
      return `Router mode: ${mode}${mode === "auto" ? " (pin cleared)" : ""}`;
    },

    routeTo: async (ctx, phase) => {
      store.pinned = false; // explicit phase pick re-engages routing
      store.pinnedModelKey = undefined;
      // Learn: a manual /route right after an auto switch is a correction signal.
      if (
        store.lastDecision?.action === "switch" &&
        store.lastDecision.phaseTo !== phase &&
        config.calibration.enabled
      ) {
        applyCorrection(calibration, store.lastDecision, phase, config);
      }
      store.undoStack.push({ phase: store.phase, modelKey: currentModelKey(ctx) });
      if (store.undoStack.length > 20) store.undoStack.shift();
      const res = await applyRoute(pi, ctx, config, store, phase, {});
      if (!res.ok) {
        if (res.warning) return `Could not switch to ${phase}: ${res.warning}`;
        return `Could not switch to ${phase}`;
      }
      store.phase = res.phase;
      store.turnsSinceSwitch = 0;
      const d = buildDecision(store.phase, res.phase, "forced", 1, {}, ["manual"], "manual", `/route ${phase}`, res.modelKey, res.thinking);
      store.lastDecision = d;
      log.record(d);
      refreshFooter(ctx);
      return `Routed → ${res.phase} · ${res.modelKey}${res.thinking ? ` · ${res.thinking}` : ""}`;
    },

    clearPin: (ctx) => {
      if (!store.pinned) return "Not pinned.";
      store.pinned = false;
      store.pinnedModelKey = undefined;
      refreshFooter(ctx);
      return "Pin cleared — auto routing resumed.";
    },

    undo: async (ctx) => {
      const entry = store.undoStack.pop();
      if (!entry) return "Nothing to undo.";
      // Learn from the correction: the user rejected the last auto pick.
      if (store.lastDecision && config.calibration.enabled) {
        applyCorrection(calibration, store.lastDecision, entry.phase, config);
      }
      const res = await applyRoute(pi, ctx, config, store, entry.phase, {});
      if (res.ok) {
        store.phase = res.phase;
        store.turnsSinceSwitch = 0;
        refreshFooter(ctx);
        return `Reverted → ${res.phase} · ${res.modelKey}`;
      }
      return `Could not revert to ${entry.phase}`;
    },

    explain: () => {
      const d = store.lastDecision;
      if (!d) return "No routing decision yet.";
      const ranked = Object.entries(d.scores)
        .sort((a, b) => b[1] - a[1])
        .map(([p, v]) => `${p}:${v.toFixed(2)}`)
        .join("  ");
      return [
        `Decision: ${d.action} → ${d.phaseTo}`,
        `Confidence: ${d.confidence}  (${d.source})`,
        `Reason: ${d.reason}`,
        `Signals: ${d.signals.join(", ") || "none"}`,
        `Scores: ${ranked || "—"}`,
      ].join("\n");
    },

    history: (n) => {
      const items = log.recent(n);
      if (items.length === 0) return "No decisions logged yet.";
      return items
        .map((d) => `${d.ts.slice(11, 19)}  ${d.action.padEnd(7)} ${d.phaseFrom}→${d.phaseTo}  conf ${d.confidence}  [${d.signals.join(",")}]`)
        .join("\n");
    },

    reload: (ctx) => {
      fingerprint = ""; // force reload
      const warnings = maybeReload(ctx);
      refreshFooter(ctx);
      const head = `Config reloaded. mode=${config.mode}, routes=${Object.keys(config.routes).join("/")}`;
      return warnings.length ? `${head}\n${warnings.join("\n")}` : head;
    },

    resetCalibration: () => {
      calibration = resetCalibration();
      return "Calibration reset.";
    },

    toggleLlm: (on) => {
      const next = typeof on === "boolean" ? on : !config.llm.enabled;
      overrides.llmEnabled = next;
      config.llm.enabled = next;
      return `LLM tiebreak: ${next ? "on" : "off"}${next && config.llm.model ? ` (${config.llm.model})` : ""}`;
    },

    health: (ctx, action) => {
      if ((action ?? "").toLowerCase() === "reset") {
        store.unhealthyModels.clear();
        refreshFooter(ctx);
        return "Model health reset — all models eligible again.";
      }
      const now = Date.now();
      const entries = [...store.unhealthyModels.entries()].filter(([, exp]) => exp > now);
      if (entries.length === 0) return "All models healthy.";
      return `Unhealthy (cooldown):\n${entries.map(([k, exp]) => `  ${k}  ${Math.ceil((exp - now) / 1000)}s`).join("\n")}`;
    },

    budget: (ctx, action) => {
      if ((action ?? "").toLowerCase() === "reset") {
        // Clear the over-budget pin if it was the one we applied.
        if (store.budgetPinApplied && store.pinned) {
          store.pinned = false;
          store.pinnedModelKey = undefined;
        }
        store.sessionCostUsd = 0;
        store.budgetWarned = false;
        store.budgetDowngraded = false;
        store.budgetPinApplied = false;
        refreshFooter(ctx);
        return "Budget counters reset.";
      }
      if (!config.budget.enabled || config.budget.maxSessionUsd <= 0) return "Budget guard disabled.";
      const pct = ((store.sessionCostUsd / config.budget.maxSessionUsd) * 100).toFixed(0);
      return `Budget: $${store.sessionCostUsd.toFixed(2)} / $${config.budget.maxSessionUsd.toFixed(2)} (${pct}%)${store.budgetDowngraded ? " — over budget" : ""}`;
    },
  };
}

// ─── extension entry ─────────────────────────────────────────────────────────

export default function modelRouter(pi: ExtensionAPI): void {
  ensureStarterConfig();
  calibration = loadCalibration();

  pi.on("session_start", (event: SessionStartEvent, ctx) => {
    try {
      cwd = ctx.cwd;
      const res = loadConfig(cwd, config);
      config = res.config;
      applyOverrides(config);
      fingerprint = res.fingerprint;

      // Reset per-session state, then optionally restore from session entries.
      store = new RouterStore(config.defaultRoute);
      log = new DecisionLog(deriveSessionId(ctx), config.log);

      // Restore on reload too, so editing config / `/reload` does not reset the
      // phase mid-work. New/fork intentionally start clean at the default route.
      const restorable =
        event.reason === "startup" || event.reason === "resume" || event.reason === "reload";
      if (restorable) {
        try {
          const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
          const last = entries.filter((e) => e.type === "custom" && e.customType === "model-router-state").pop();
          if (last?.data) store.applyPersisted(last.data as any, config);
        } catch {
          /* no restorable state */
        }
      }

      // Register commands every session_start. On /reload the module may be
      // cached, so a one-time guard can leave commands missing in the new
      // runtime. registerIfFree/registerShortcut swallow conflicts safely.
      registerCommands(pi, makeRuntime(pi));
      registerShortcut(pi);

      for (const w of res.warnings) toast(ctx, w, "warning");
      refreshFooter(ctx);
    } catch (err) {
      toast(ctx, `model-router init failed: ${(err as Error).message}`, "error");
    }
  });

  pi.on("input", async (event, ctx) => {
    try {
      if (!store) return { action: "continue" as const };
      // Replayed turn after a runtime fallback: keep the fallback model, do not
      // re-classify/route this one.
      if (store.pendingResubmit) {
        store.pendingResubmit = false;
        return { action: "continue" as const };
      }
      // Genuine new prompt: remember it (for fallback replay) and reset the
      // per-request fallback bookkeeping.
      if (event.source === "interactive" && !event.streamingBehavior) {
        store.lastUserText = event.text ?? "";
        store.lastUserImages = event.images;
        store.resetTurnFallback();
      }
      if (eligible(ctx, event)) {
        await processInput(pi, ctx, event);
      }
    } catch (err) {
      toast(ctx, `model-router input error: ${(err as Error).message}`, "warning");
    }
    return { action: "continue" as const };
  });

  // Detect a manual model switch (not one we initiated) → pin.
  pi.on("model_select", (event, ctx) => {
    try {
      if (!store) return;
      if (event.source === "restore") return;
      if (store.routerSwitching) return; // our own switch
      store.pinned = true;
      store.pinnedModelKey = `${event.model.provider}/${event.model.id}`;
      toast(ctx, `model-router: pinned to ${event.model.id} — auto paused (/route auto to resume)`);
      refreshFooter(ctx);
    } catch {
      /* ignore */
    }
  });

  // Inject the active route's instructions into the system prompt.
  pi.on("before_agent_start", (event, _ctx) => {
    try {
      if (!store || !config) return;
      const route = config.routes[store.phase];
      if (route?.instructions) {
        return { systemPrompt: `${event.systemPrompt}\n\n${route.instructions}` };
      }
    } catch {
      /* ignore */
    }
  });

  // Feed the recent-tool signal window.
  pi.on("tool_execution_end", (event, _ctx) => {
    try {
      if (store && config) store.pushTool(event.toolName, config.toolWindow);
    } catch {
      /* ignore */
    }
  });

  // Dwell counter + persistence.
  pi.on("turn_start", (_event, _ctx) => {
    try {
      if (store) store.turnsSinceSwitch++;
    } catch {
      /* ignore */
    }
  });

  // Terminal end of an agent run. Persist, then handle runtime provider errors
  // by hopping to a similar model and replaying the prompt.
  pi.on("agent_end", async (event, ctx) => {
    try {
      if (!store || !config) return;
      persist(pi);
      await handleRuntimeFallback(pi, ctx, event.messages as AgentMessageLike[]);
    } catch {
      /* ignore */
    }
  });

  // Budget accounting.
  pi.on("message_end", (event, ctx) => {
    try {
      if (!store || !config) return;
      const msg = event.message as { role?: string; usage?: { cost?: { total?: number } } };
      if (msg.role !== "assistant" || !msg.usage?.cost) return;
      const report = recordCost(msg.usage.cost.total ?? 0, store, config);
      if (report.warning) toast(ctx, report.warning, "warning");
      if (report.forceRoute) refreshFooter(ctx); // applied on next input
    } catch {
      /* ignore */
    }
  });
}

/** Best-effort stable id for the decision log filename. */
function deriveSessionId(ctx: ExtensionContext): string {
  try {
    const anySm = ctx.sessionManager as unknown as { getSessionId?: () => string; sessionId?: string };
    return anySm.getSessionId?.() ?? anySm.sessionId ?? `${Date.now()}`;
  } catch {
    return `${Date.now()}`;
  }
}

/** Optional shortcut to cycle auto → suggest → off, if the key is free. */
function registerShortcut(pi: ExtensionAPI): void {
  try {
    pi.registerShortcut("ctrl+shift+r", {
      description: "model-router: cycle mode (auto → suggest → off)",
      handler: (ctx) => {
        const order: RouterMode[] = ["auto", "suggest", "off"];
        const next = order[(order.indexOf(config.mode) + 1) % order.length]!;
        overrides.mode = next;
        config.mode = next;
        if (next === "auto") { store.pinned = false; store.pinnedModelKey = undefined; }
        refreshFooter(ctx);
        toast(ctx, `Router mode: ${next}`);
      },
    });
  } catch {
    /* key taken — non-fatal */
  }
}
