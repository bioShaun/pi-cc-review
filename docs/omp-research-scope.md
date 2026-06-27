# OMP Research Scope — for the CC Review Orchestrator plugin

## Target

**Project:** Oh My Posh (`oh-my-posh`, https://ohmyposh.dev, repo `JanDeDobbeleer/oh-my-posh`) — interpreted here as the canonical "omp" reference. If the user actually meant a different "omp" (e.g., an internal tool), this scope should be re-pointed before any deeper comparison is done.

## Scope note (1–2 sentences)

Oh My Posh is a cross-shell prompt theme engine whose primary purpose is to render configurable, segment-based shell prompts driven by a JSON/YAML/TOML config with strict schema validation, layered config precedence, and built-in debug/diagnostic commands. Within the CC Review Orchestrator plugin (`.pi/extensions/cc-review.ts`), we will compare OMP against the following 3–5 feature areas — chosen because they are the areas where OMP's design has plausible, transferable lessons; OMP has nothing to teach us about agent planning/review/retry semantics, so those are explicitly out of scope.

## Comparison areas (in-scope, max 5)

1. **Configuration & parameter precedence** — OMP's `--config` flag → `POSH_THEME` env → built-in default vs. CC Review's `--provider` / `--log-level` flag → `CC_REVIEW_PROVIDER` / `CC_REVIEW_LOG_LEVEL` env → default chain (`resolveCcReviewLogLevel`, `parseCcReviewCommandArgs`).
2. **Schema-validated user input with graceful fallback** — OMP's JSON Schema for theme files + `oh-my-posh config migrate`/validation errors vs. CC Review's `CcReviewParams` JSON schema and the "invalid input → fall back + emit one warning" pattern.
3. **Theme/segment rendering abstraction** — OMP's segment/template engine and theme objects vs. CC Review's `buildCcReviewWidgetLines`, `plainWidgetTheme`, status/checklist/retry widget composition.
4. **Diagnostics & structured log surfaces** — OMP's `oh-my-posh debug` / `print debug` / timing output vs. CC Review's `appendPersistedLogEntry` (unfiltered JSONL), severity-filtered live-log slice, and `onUpdate` delta path.
5. **CLI ↔ programmatic-API parity** — OMP's shared option surface between shell-init invocation and library use vs. CC Review's slash-command (`/cc-review`) and tool (`cc_review`) sharing one `RunCcReviewWorkflowOptions` shape.

## Explicitly out of scope

- Planning (Codex task break-down), per-task subagent execution, review/fix retry loop, and cancellation semantics — OMP has no comparable feature surface and any comparison would be vacuous.
- Provider abstraction between codex and claude as planner/reviewer backends.
