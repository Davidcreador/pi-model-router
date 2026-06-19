# Changelog

All notable changes to this project are documented here.

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
