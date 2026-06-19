/**
 * The `/route` command surface.
 *
 * Registered via a free-name helper so a taken command never crashes load.
 * Commands operate on a Runtime handed in by index.ts (which owns the live
 * config/store/log), keeping this module free of event-wiring concerns.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { RouterMode, Phase } from "./types.ts";

/** Surface the index.ts internals the commands need, without a circular import. */
export interface Runtime {
  phases(): Phase[];
  status(ctx: ExtensionCommandContext): string;
  setMode(ctx: ExtensionCommandContext, mode: RouterMode): Promise<string>;
  routeTo(ctx: ExtensionCommandContext, phase: Phase): Promise<string>;
  clearPin(ctx: ExtensionCommandContext): string;
  undo(ctx: ExtensionCommandContext): Promise<string>;
  explain(): string;
  history(n: number): string;
  reload(ctx: ExtensionCommandContext): string;
  resetCalibration(): string;
  toggleLlm(on: boolean | undefined): string;
  budget(ctx: ExtensionCommandContext, action: string | undefined): string;
  health(ctx: ExtensionCommandContext, action: string | undefined): string;
}

/** Register `name` only if no other extension owns it. Returns success. */
function registerIfFree(
  pi: ExtensionAPI,
  name: string,
  options: Omit<RegisteredCommand, "name" | "sourceInfo">,
): boolean {
  try {
    pi.registerCommand(name, options);
    return true;
  } catch {
    return false;
  }
}

const SUBCOMMANDS = [
  "status", "auto", "suggest", "off", "explain", "history",
  "undo", "unpin", "reload", "llm", "calibration", "budget", "health",
];

export function registerCommands(pi: ExtensionAPI, rt: Runtime): { primary: boolean; alias: boolean } {
  const handler = async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
    const args = rawArgs.trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] ?? "status").toLowerCase();
    const phases = rt.phases();

    try {
      if (sub === "status" || sub === "") {
        ctx.ui.notify(rt.status(ctx), "info");
        return;
      }
      if (sub === "auto") {
        ctx.ui.notify(await rt.setMode(ctx, "auto"), "info");
        return;
      }
      if (sub === "suggest") {
        ctx.ui.notify(await rt.setMode(ctx, "suggest"), "info");
        return;
      }
      if (sub === "off") {
        ctx.ui.notify(await rt.setMode(ctx, "off"), "info");
        return;
      }
      if (sub === "unpin") {
        ctx.ui.notify(rt.clearPin(ctx), "info");
        return;
      }
      if (sub === "undo") {
        ctx.ui.notify(await rt.undo(ctx), "info");
        return;
      }
      if (sub === "explain") {
        ctx.ui.notify(rt.explain(), "info");
        return;
      }
      if (sub === "history") {
        const n = Math.max(1, Math.min(50, parseInt(args[1] ?? "10", 10) || 10));
        ctx.ui.notify(rt.history(n), "info");
        return;
      }
      if (sub === "reload") {
        ctx.ui.notify(rt.reload(ctx), "info");
        return;
      }
      if (sub === "calibration") {
        if ((args[1] ?? "").toLowerCase() === "reset") {
          ctx.ui.notify(rt.resetCalibration(), "info");
        } else {
          ctx.ui.notify("Usage: /route calibration reset", "info");
        }
        return;
      }
      if (sub === "llm") {
        const v = (args[1] ?? "").toLowerCase();
        const on = v === "on" ? true : v === "off" ? false : undefined;
        ctx.ui.notify(rt.toggleLlm(on), "info");
        return;
      }
      if (sub === "budget") {
        ctx.ui.notify(rt.budget(ctx, args[1]), "info");
        return;
      }
      if (sub === "health") {
        ctx.ui.notify(rt.health(ctx, args[1]), "info");
        return;
      }
      // /route <phase>
      if (phases.includes(sub)) {
        ctx.ui.notify(await rt.routeTo(ctx, sub), "info");
        return;
      }
      ctx.ui.notify(
        `Unknown: /route ${sub}\nPhases: ${phases.join(", ")}\nSubcommands: ${SUBCOMMANDS.join(", ")}`,
        "warning",
      );
    } catch (err) {
      ctx.ui.notify(`model-router command error: ${(err as Error).message}`, "error");
    }
  };

  const getArgumentCompletions = (prefix: string) => {
    const parts = prefix.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      const cur = parts[0] ?? "";
      return [...rt.phases(), ...SUBCOMMANDS]
        .filter((x) => x.startsWith(cur))
        .map((x) => ({ value: x, label: x }));
    }
    return null;
  };

  const primary = registerIfFree(pi, "route", {
    description: "Dynamic model router: status / auto|suggest|off / <phase> / explain / history / undo / unpin / reload / llm / calibration",
    getArgumentCompletions,
    handler,
  });
  const alias = registerIfFree(pi, "rt", {
    description: "Alias for /route",
    getArgumentCompletions,
    handler,
  });

  return { primary, alias };
}
