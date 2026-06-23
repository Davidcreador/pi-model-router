# Changelog

All notable changes to this project are documented here.

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
