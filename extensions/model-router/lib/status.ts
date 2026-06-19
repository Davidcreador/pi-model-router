/**
 * Footer status string builder.
 *
 * Uses ctx.ui.setStatus("route", ...) (never setFooter/setHeader) so it
 * coexists with pi-powerline and other status-owning extensions. Returns the
 * raw string; the caller applies theme coloring if desired.
 */

import type { RouterStore } from "./state.ts";
import type { RouterConfig } from "./types.ts";

/** Short model label: drop the provider prefix for compactness. */
function shortModel(modelKey: string | undefined): string {
  if (!modelKey) return "—";
  const slash = modelKey.indexOf("/");
  return slash >= 0 ? modelKey.slice(slash + 1) : modelKey;
}

/**
 * Build the footer text. `suggestion` (when present) renders the unobtrusive
 * "looks like X" hint used by the hybrid-confidence policy.
 */
export function buildStatus(
  store: RouterStore,
  config: RouterConfig,
  currentModelKey: string | undefined,
  suggestion?: string,
): string {
  if (!config.enabled || config.mode === "off") {
    return "route:off";
  }
  if (store.pinned) {
    return `route:PINNED ${shortModel(store.pinnedModelKey ?? currentModelKey)}`;
  }

  const thinking = store.lastDecision?.thinking;
  const base = `route:${store.phase} · ${shortModel(currentModelKey)}${thinking ? ` · ${thinking}` : ""}`;
  if (suggestion && suggestion !== store.phase) {
    return `${base}  ↑${suggestion}? /route ${suggestion}`;
  }
  if (config.mode === "suggest") return `${base} (suggest)`;
  return base;
}
