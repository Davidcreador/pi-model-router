/**
 * Apply a route: resolve model (with speed/vision/health/fallback handling),
 * validate auth, then set model + thinking + tools. Never throws; returns a
 * result the caller uses for notify/log/footer.
 *
 * Resolution order for a route's model (first usable wins):
 *   1. the route's model (speed variant first, then base)
 *   2. the route's `fallbacks`
 *   3. `config.modelFallbacks[primary]`
 *   4. any other route's model (generic "similar available" net)
 * A candidate is usable only if it is registered, authenticated, healthy
 * (not in error cooldown), and — for image prompts — vision-capable.
 *
 * If nothing in the route's chain is usable, we fall back to the default route's
 * chain and warn once.
 */

import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "./config.ts";
import type { RouterStore } from "./state.ts";
import type { Phase, RouteConfig, RouterConfig, Speed, ThinkingLevel } from "./types.ts";

export interface ApplyResult {
  ok: boolean;
  phase: Phase;
  modelKey?: string;
  thinking?: ThinkingLevel;
  fellBackTo?: Phase;
  /** True when a model other than the route's primary was selected. */
  usedFallbackModel?: boolean;
  warning?: string;
}

/** "provider/id" key for a resolved model. */
export function keyOf(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

function speedSuffix(speed: Speed | undefined): string | undefined {
  if (speed === "fast") return ":fast";
  if (speed === "slow") return ":slow";
  return undefined;
}

function speedThinking(speed: Speed | undefined): ThinkingLevel | undefined {
  if (speed === "fast") return "low";
  if (speed === "slow") return "high";
  return undefined;
}

export interface ResolveOpts {
  hasImage?: boolean;
  requireHealthy?: boolean;
  requireAuth?: boolean;
}

/** Resolve a single "provider/id" key to a usable Model, or undefined. */
export function resolveKey(
  ctx: ExtensionContext,
  store: RouterStore,
  key: string,
  opts: ResolveOpts = {},
): Model<any> | undefined {
  const { hasImage = false, requireHealthy = true, requireAuth = true } = opts;
  const ref = parseModelRef(key);
  if (!ref) return undefined;
  const model = ctx.modelRegistry.find(ref.provider, ref.modelId) as Model<any> | undefined;
  if (!model) return undefined;
  if (requireAuth && !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
  if (requireHealthy && !store.isHealthy(keyOf(model))) return undefined;
  if (hasImage && !model.input.includes("image")) return undefined;
  return model;
}

/** Ordered candidate keys for a route: primary, route fallbacks, model map, then any route model. */
function routeCandidateKeys(config: RouterConfig, route: RouteConfig): string[] {
  const primary = route.model;
  const fromRoute = route.fallbacks ?? [];
  const fromMap = config.modelFallbacks?.[primary] ?? [];
  const fromOtherRoutes = Object.values(config.routes).map((r) => r.model);
  return dedupe([primary, ...fromRoute, ...fromMap, ...fromOtherRoutes]);
}

/** Try the speed variant of the route's primary, then the base id. */
function resolvePrimary(
  ctx: ExtensionContext,
  store: RouterStore,
  route: RouteConfig,
  opts: ResolveOpts,
): Model<any> | undefined {
  const ref = parseModelRef(route.model);
  if (!ref) return undefined;
  const suffix = speedSuffix(route.speed);
  if (suffix && !ref.modelId.includes(":")) {
    const variant = resolveKey(ctx, store, `${ref.provider}/${ref.modelId}${suffix}`, opts);
    if (variant) return variant;
  }
  return resolveKey(ctx, store, route.model, opts);
}

/** Pick the best usable model for a route (primary, else fallback chain). */
export function pickRouteModel(
  ctx: ExtensionContext,
  config: RouterConfig,
  store: RouterStore,
  route: RouteConfig,
  opts: { hasImage?: boolean } = {},
): { model: Model<any>; usedFallback: boolean } | undefined {
  const primary = resolvePrimary(ctx, store, route, { hasImage: opts.hasImage });
  if (primary) return { model: primary, usedFallback: false };
  for (const key of routeCandidateKeys(config, route)) {
    const m = resolveKey(ctx, store, key, { hasImage: opts.hasImage });
    if (m) return { model: m, usedFallback: true };
  }
  return undefined;
}

/**
 * Pick a fallback model after a runtime error on `failedKey`. Considers the
 * per-model map first, then every route's model, skipping anything in
 * `exclude`, unhealthy, unauthenticated, or (for images) non-vision.
 */
export function pickFallbackForKey(
  ctx: ExtensionContext,
  config: RouterConfig,
  store: RouterStore,
  failedKey: string,
  opts: { hasImage?: boolean; exclude?: Set<string> } = {},
): { model: Model<any>; key: string } | undefined {
  const exclude = opts.exclude ?? new Set<string>();
  const candidates = dedupe([
    ...(config.modelFallbacks?.[failedKey] ?? []),
    ...Object.values(config.routes).map((r) => r.model),
  ]);
  for (const key of candidates) {
    if (exclude.has(key)) continue;
    const m = resolveKey(ctx, store, key, { hasImage: opts.hasImage });
    if (!m) continue;
    const resolvedKey = keyOf(m);
    if (exclude.has(resolvedKey)) continue;
    return { model: m, key: resolvedKey };
  }
  return undefined;
}

/** Find a vision-capable route (model accepts image input). */
function pickVisionRoute(
  ctx: ExtensionContext,
  config: RouterConfig,
  store: RouterStore,
): { phase: Phase; model: Model<any> } | undefined {
  const ordered = Object.entries(config.routes).sort(
    (a, b) => (b[1].requiresVision ? 1 : 0) - (a[1].requiresVision ? 1 : 0),
  );
  for (const [phase, route] of ordered) {
    const m = pickRouteModel(ctx, config, store, route, { hasImage: true });
    if (m) return { phase, model: m.model };
  }
  return undefined;
}

function clamp(model: Model<any>, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  if (!level) return undefined;
  try {
    const supported = getSupportedThinkingLevels(model);
    if (supported.includes(level)) return level;
    return clampThinkingLevel(model, level) as ThinkingLevel;
  } catch {
    return level;
  }
}

/** Keep only tool names that actually exist in this session. */
function filterTools(pi: ExtensionAPI, tools: string[]): string[] {
  let known: Set<string>;
  try {
    known = new Set(pi.getAllTools().map((t) => t.name));
  } catch {
    return tools;
  }
  return tools.filter((t) => known.has(t));
}

/**
 * Apply the route for `phase`. `opts.hasImage` triggers vision handling,
 * `opts.speedBias`/`opts.depthBias` nudge thinking when the route leaves it open.
 */
export async function applyRoute(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RouterConfig,
  store: RouterStore,
  phase: Phase,
  opts: { hasImage?: boolean; speedBias?: boolean; depthBias?: boolean } = {},
): Promise<ApplyResult> {
  let targetPhase = phase;
  let route = config.routes[targetPhase];
  if (!route) return { ok: false, phase, warning: `route "${phase}" not found` };

  let warning: string | undefined;
  let fellBackTo: Phase | undefined;

  let picked = pickRouteModel(ctx, config, store, route, { hasImage: opts.hasImage });

  // Image prompt with no vision-capable candidate in this route ⇒ reroute to vision.
  if (!picked && opts.hasImage) {
    const vision = pickVisionRoute(ctx, config, store);
    if (vision) {
      targetPhase = vision.phase;
      route = config.routes[targetPhase]!;
      picked = { model: vision.model, usedFallback: true };
      fellBackTo = vision.phase;
    } else if (store.shouldWarn("no-vision")) {
      warning = "image attached but no vision-capable route available; keeping current model";
    }
  }

  // Nothing usable in this route's chain ⇒ try the default route's chain.
  if (!picked) {
    if (store.shouldWarn(`unusable:${targetPhase}`)) {
      warning = `route "${targetPhase}" has no usable model (registry/auth/health); using default route`;
    }
    const def = config.routes[config.defaultRoute];
    const defPick = def ? pickRouteModel(ctx, config, store, def, { hasImage: opts.hasImage }) : undefined;
    if (def && defPick) {
      targetPhase = config.defaultRoute;
      route = def;
      picked = defPick;
      fellBackTo = config.defaultRoute;
    } else {
      return { ok: false, phase: targetPhase, warning: warning ?? "no usable model" };
    }
  }

  const resolved = picked.model;

  // Thinking: explicit route level wins, else speed-derived, else prompt bias.
  let thinking: ThinkingLevel | undefined = route.thinkingLevel ?? speedThinking(route.speed);
  if (!thinking) {
    if (opts.depthBias) thinking = "high";
    else if (opts.speedBias) thinking = "low";
  }
  thinking = clamp(resolved, thinking);

  store.routerSwitching = true;
  try {
    const ok = await pi.setModel(resolved);
    if (!ok) {
      if (store.shouldWarn(`setmodel:${targetPhase}`)) {
        warning = `could not switch to ${keyOf(resolved)} (no API key)`;
      }
      return { ok: false, phase: targetPhase, warning };
    }
    if (thinking) pi.setThinkingLevel(thinking);
    if (route.tools && route.tools.length > 0) {
      const valid = filterTools(pi, route.tools);
      if (valid.length > 0) pi.setActiveTools(valid);
    }
  } finally {
    store.routerSwitching = false;
  }

  return {
    ok: true,
    phase: targetPhase,
    modelKey: keyOf(resolved),
    thinking,
    fellBackTo,
    usedFallbackModel: picked.usedFallback,
    warning,
  };
}
