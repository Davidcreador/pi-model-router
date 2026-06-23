# Changelog

All notable changes to this project are documented here.

## [1.0.5] - 2026-06-23

### Fixed

- **Debounced fallback to avoid Pi retry conflict**: the root cause of
  "Retry failed after N attempts: Retry cancelled" was that `agent_end` fires
  DURING the agent run, BEFORE Pi's own auto-retry cycle. Calling
  `sendUserMessage` or `setModel` during `agent_end` raced with Pi's retry
  backoff sleep. Now the handler debounces: each `agent_end` resets a 1.5s
  timer; when it fires (no more agent_end events = Pi's retries are done),
  the model switch and prompt replay happen safely on a truly idle agent.

- **Removed same-model retry**: Pi already has its own auto-retry with
  exponential backoff for connection errors. Our same-model retry was
  doubling the work and creating conflicts. Now we only switch models when
  Pi's own retries are exhausted.

- **Debounce cleared on new input/session start**: prevents stale fallback
  timers from firing after the user starts a new prompt or reloads.

## [1.0.4] - 2026-06-23

### Fixed

- **Deferred replay until idle**: the replayed prompt now waits for Pi to be
  truly idle (polling `ctx.isIdle()`) before sending, instead of queuing a
  `followUp` during `agent_end`. This eliminates the "Retry failed after N
  attempts: Retry cancelled" error caused by Pi's internal retry system not
  having fully settled when the replay was queued.
- **setModel failure guard**: if a model switch fails (e.g. unauthenticated),
  the router skips that fallback instead of replaying on the wrong model.
- **Stale context guard**: the deferred replay catches errors from invalidated
  contexts (session shutdown/reload during the wait) and cleans up
  `pendingResubmit` silently.
- **pendingResubmit timing**: `pendingResubmit` is now set right before the
  actual send, not before the idle wait, so user messages typed during the
  wait are still routed normally.

## [1.0.3] - 2026-06-23

### Fixed

- **Retry same model before fallback**: on a provider/connection error, the
  router now retries the same model `retryAttempts` times (default 2) before
  switching to a fallback. This prevents needless model hopping on transient
  connection errors.
- **`deliverAs` option fix**: the replay now uses `deliverAs: "followUp"`
  (the correct ExtensionAPI option name) instead of `streamingBehavior`,
  eliminating the "Agent is already processing" error.
- **No-prompt guard**: if no user prompt was captured, the router notifies
  instead of silently failing.

## [1.0.2] - 2026-06-19

### Fixed

- `/route` command now re-registers on every `session_start`, preventing it
  from disappearing after `/reload` when the module is cached.

## [1.0.1] - 2026-06-19

### Fixed

- Fallback replay now queues with `streamingBehavior: "followUp"` so it no
  longer throws "Agent is already processing" when `agent_end` fires while Pi
  is still streaming.

### Added

- README images: hero, footer examples, fallback flow, command reference.

## [1.0.0] - 2026-06-19

### Added

- Initial public Pi package.
- Dynamic phase-based routing for investigate, plan, implement, review, and debug work.
- Heuristic-first classifier with optional LLM tie-break.
- Sticky phase policy and hybrid switch/suggest/stay behavior.
- Manual model pin detection and `/route auto` / `/route unpin` recovery.
- Runtime model fallback with unhealthy-model cooldowns and prompt replay.
- Budget guard with session spend tracking.
- Calibration from `/route undo` and manual route corrections.
- `/route` command suite: status, explain, history, undo, health, budget, llm, reload.
- Global config at `~/.pi/agent/model-router.json` and project overrides at `.pi/model-router.json`.
- GitHub Actions CI and release workflows.
