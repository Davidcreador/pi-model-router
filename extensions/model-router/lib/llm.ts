/**
 * Optional LLM tiebreak classifier (Tier 3).
 *
 * Fired only when the heuristic lands in the configured dead-band. It is:
 *   - time-boxed (hard AbortController timeout),
 *   - cheap (uses a small configured model),
 *   - non-fatal (any error/timeout falls back to the heuristic result).
 *
 * It calls the model directly via `completeSimple` from @earendil-works/pi-ai,
 * resolving auth through Pi's ModelRegistry — the same path the agent loop uses
 * for the streamSimple providers.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "./config.ts";
import type { Classification, Phase, RouterConfig } from "./types.ts";

/** Extract the assistant's plain text from a completed message. */
function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("")
    .trim();
}

/**
 * Ask a cheap model to pick a phase. Returns a refined Classification or the
 * original heuristic result on any failure.
 */
export async function llmTiebreak(
  ctx: ExtensionContext,
  config: RouterConfig,
  prompt: string,
  heuristic: Classification,
): Promise<Classification> {
  if (!config.llm.enabled || !config.llm.model) return heuristic;

  const ref = parseModelRef(config.llm.model);
  if (!ref) return heuristic;

  const model = ctx.modelRegistry.find(ref.provider, ref.modelId) as Model<any> | undefined;
  if (!model) return heuristic;

  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch {
    return heuristic;
  }
  if (!auth?.ok || !auth.apiKey) return heuristic;

  const phases = Object.keys(config.routes);
  const system =
    "You are a router. Classify the user's coding request into exactly one phase. " +
    `Allowed phases: ${phases.join(", ")}. ` +
    "Reply with ONLY the phase word, lowercase, nothing else.";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);

  try {
    const message = await completeSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt.slice(0, 2000) }], timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: controller.signal,
        maxTokens: 8,
        reasoning: undefined,
      },
    );
    const answer = textOf(message).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const picked = phases.find((p) => answer === p) ?? phases.find((p) => answer.includes(p));
    if (!picked) return heuristic;

    return {
      ...heuristic,
      phase: picked as Phase,
      // LLM verdict raises confidence to just over the switch threshold so the
      // policy layer acts on it, but we keep it below 1 to distinguish from hard signals.
      confidence: Math.max(heuristic.confidence, config.switchThreshold + 0.05),
      ambiguous: false,
      source: "llm",
      signals: [...heuristic.signals, "llm"],
    };
  } catch {
    return heuristic;
  } finally {
    clearTimeout(timer);
  }
}
