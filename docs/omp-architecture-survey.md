# Oh My Posh — Architecture & Public-Surface Survey

> Scope target fixed by `docs/omp-research-scope.md`: **Oh My Posh** (`oh-my-posh`, JanDeDobbeleer/oh-my-posh). This survey is a concise map; it does not prescribe which lessons CC Review should adopt.

## 1. Workflow stages

Oh My Posh is invoked once per shell prompt as a short-lived CLI. The pipeline is:

1. **Init / hook injection** — `oh-my-posh init <shell> --config <path>` emits a shell-specific snippet (bash, zsh, fish, pwsh, nu, cmd via Clink, elvish, xonsh) into the user's rc file.
2. **Per-prompt invocation** — the injected hook calls `oh-my-posh print primary|secondary|right|transient|tooltip|debug|valid` with context flags (`--shell`, `--status`, `--no-status`, `--execution-time`, `--pswd`, `--terminal-width`, `--job-count`, `--stack-count`).
3. **Config load + parse** — JSON / YAML / TOML theme file resolved, validated against an embedded schema, palette resolved.
4. **Segment evaluation** — blocks of segments (left/right/rprompt/newline) are walked; each segment gathers data (git, kubectl, lang version, time, env, command output…) and renders through a Go `text/template` expression.
5. **Composition + emit** — ANSI/Powerline glyphs are stitched into a single string and written to stdout for the shell to consume; transient prompt and tooltips run as separate `print` calls triggered by keypress / accepted line.

## 2. Configuration precedence

Resolution order, first-match wins:

1. `--config <path|url>` flag on the current command.
2. `POSH_THEME` environment variable.
3. Config persisted by the injected init snippet (effectively a frozen `--config`).
4. Built-in default theme compiled into the binary.

Within a resolved theme, segment defaults < theme palette < per-segment `properties` / `template` < runtime CLI context flags.

## 3. CLI surface & notable flags

Top-level subcommands: `init`, `print`, `debug`, `config (migrate|edit|export|get)`, `cache (path|clear|edit)`, `font install`, `upgrade`, `notice`, `get (shell|millis|accent)`, `enable/disable (notice|upgrade|autoupgrade)`, `toggle`.

Cross-cutting flags worth noting: `--config`, `--shell`, `--strict` (fail on template errors instead of swallowing), `--eval` (init mode), `--plain` (strip ANSI), `--cleanse`, `--debug`. Context flags (`--status`, `--execution-time`, `--pswd`, `--terminal-width`, `--job-count`) are passed in by the shell hook, not the user.

## 4. Extension points

- **Segment catalog** — ~80 built-in segment `type`s; new behaviour is usually a config change, not code.
- **`command` segment** — runs an arbitrary shell command and templates its output; the escape hatch for non-built-in data sources.
- **Template engine** — Go `text/template` plus custom funcs (`glob`, `hresize`, `secondsRound`, `formatTime`, `url`, `hex2rgb`, `replace`, palette `p:name`).
- **Cross-segment styling** — palettes, cycle arrays, foreground/background templates conditioned on segment state.
- **Transient prompt & tooltips** — declarative hooks that re-render on command accept / on a matching first token.
- **Schema-first authoring** — a hosted JSON Schema drives editor validation, and `oh-my-posh config migrate` carries old themes forward.

## 5. Observability & logging

- `oh-my-posh debug` (and `print debug`) prints a structured report: resolved config path, version, per-segment timings in ms, template errors, and the final rendered prompt — the canonical "why is my prompt slow / wrong" tool.
- `--strict` promotes template errors from silent fallbacks to hard failures.
- Cache directory (queryable via `cache path`) stores upgrade-notice state and slow-segment caches; `cache clear` and `cache edit` are first-class.
- Notice subsystem surfaces upgrade and breaking-change messages out-of-band so they don't corrupt the prompt stream.

## Out of scope

Agent planning, review/fix retry, cancellation, and provider abstraction — OMP has no analogue and is intentionally not surveyed here.
