/**
 * JSONL decision log + in-memory history ring.
 *
 * One line per routing decision, written to
 * ~/.pi/agent/model-router/decisions-<sessionId>.jsonl when `config.log` is on.
 * Also keeps the last N decisions in memory for `/route history` without
 * re-reading the file.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Decision } from "./types.ts";

const HISTORY_MAX = 50;

export class DecisionLog {
  private history: Decision[] = [];
  private file: string;
  private enabled: boolean;

  constructor(sessionId: string, enabled: boolean) {
    this.enabled = enabled;
    const safeId = (sessionId || "session").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "session";
    this.file = join(getAgentDir(), "model-router", `decisions-${safeId}.jsonl`);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  record(decision: Decision): void {
    this.history.push(decision);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(decision)}\n`, "utf8");
    } catch {
      // Non-fatal: logging must never break a session.
    }
  }

  recent(n: number): Decision[] {
    return this.history.slice(-Math.max(1, n));
  }

  last(): Decision | undefined {
    return this.history[this.history.length - 1];
  }
}
