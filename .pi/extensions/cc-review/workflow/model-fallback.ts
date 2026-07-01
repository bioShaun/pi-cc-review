// ---------------------------------------------------------------------------
// Model fallback and attempted-model reporting (P1-3).
//
// Borrowed from pi-subagents' `model-fallback.ts`. CC Review records the
// configured/effective worker model but has no bounded fallback sequence when
// a model is unavailable, rate-limited, or misconfigured. This module adds:
//
//   * Parsing `fallbackModels` from worker frontmatter/settings.
//   * Building ordered model candidates (primary + fallbacks).
//   * A conservative retryable-failure classifier.
//   * Recording attempted models in task results and artifacts.
//
// The fallback loop itself lives in the execution phase; this module provides
// the pure resolution and classification functions.
// ---------------------------------------------------------------------------

/** Sentinel: split a `model:thinking` suffix (e.g. `claude-sonnet:high`). */
export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
  return {
    baseModel: model.substring(0, colonIdx),
    thinkingSuffix: model.substring(colonIdx),
  };
}

export interface ModelAttemptSummary {
  model: string;
  success: boolean;
  exitCode?: number | null;
  error?: string;
}

export interface ModelFallbackConfig {
  /** Primary model (already resolved to provider/id form if applicable). */
  primaryModel: string | undefined;
  /** Ordered fallback models from frontmatter/settings. */
  fallbackModels: string[];
}

/**
 * Parse a comma-separated `fallbackModels` string (as found in agent
 * frontmatter or settings) into a clean array. Empty/whitespace entries are
 * dropped. Duplicates across primary+fallback are removed.
 */
export function parseFallbackModels(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  return parts;
}

/**
 * Build the ordered list of model candidates for a task. The primary model is
 * first; fallbacks follow in declared order. Duplicates are removed so a
 * fallback that equals the primary doesn't waste a retry slot.
 */
export function buildModelCandidates(config: ModelFallbackConfig): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [config.primaryModel, ...config.fallbackModels]) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    candidates.push(trimmed);
  }
  return candidates;
}

// Conservative list of retryable model/provider failure patterns. Borrowed
// from pi-subagents; kept identical so behavior matches across plugins.
const RETRYABLE_MODEL_FAILURE_PATTERNS = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /billing/i,
  /credit/i,
  /auth(?:entication)?/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /api key/i,
  /token expired/i,
  /invalid key/i,
  /provider.*unavailable/i,
  /model.*unavailable/i,
  /model.*disabled/i,
  /model.*not found/i,
  /unknown model/i,
  /overloaded/i,
  /service unavailable/i,
  /temporar(?:ily)? unavailable/i,
  /connection refused/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /upstream/i,
  /timed? out/i,
  /timeout/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /cold.?start/i,
  /empty response/i,
  /no output/i,
  /model.*(?:load|fail|error)/i,
];

/**
 * Classify whether a model/provider failure is retryable (i.e. worth trying
 * the next fallback model). Non-retryable failures (syntax errors, genuine
 * task failures, aborts) return false so the workflow fails fast.
 */
export function isRetryableModelFailure(error: string | undefined): boolean {
  if (!error) return false;
  return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * Format a human-readable note about a model attempt and the next fallback.
 * Used in logs and task artifacts.
 */
export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
  const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
  return nextModel
    ? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
    : `[fallback] ${attempt.model} failed: ${failure}.`;
}

/**
 * Summarize the list of attempted models for artifact/report inclusion.
 * Returns undefined when only one model was attempted (no fallback happened).
 */
export function summarizeAttemptedModels(attempts: ModelAttemptSummary[]): string | undefined {
  if (attempts.length <= 1) return undefined;
  return attempts
    .map((a, i) => {
      const status = a.success ? "ok" : `failed (${a.error?.trim() || `exit ${a.exitCode ?? 1}`})`;
      return `${i + 1}. ${a.model} — ${status}`;
    })
    .join("\n");
}

/**
 * Resolve model fallback config from an agent's frontmatter and the global
 * settings. Mirrors how `applyAgentModelOverride` reads settings, extended
 * with `fallbackModels`.
 */
export interface ModelFallbackResolutionOptions {
  /** Agent frontmatter (already parsed). */
  agentFrontmatter?: Record<string, string>;
  /** Parsed ~/.pi/agent/settings.json. */
  settings?: Record<string, any> | null;
  /** Agent name (for settings.subagents.agentOverrides[name]). */
  agentName?: string;
}

export function resolveModelFallbackConfig(
  options: ModelFallbackResolutionOptions = {},
): ModelFallbackConfig {
  const fm = options.agentFrontmatter ?? {};
  const settings = options.settings ?? null;
  const agentName = options.agentName;

  // Frontmatter `fallbackModels: a, b, c`
  const fmFallback = parseFallbackModels(fm.fallbackModels);

  // Settings override: settings.subagents.agentOverrides.<name>.fallbackModels
  let settingsFallback: string[] = [];
  let settingsPrimary: string | undefined;
  if (settings && agentName) {
    const override = settings?.subagents?.agentOverrides?.[agentName];
    if (override) {
      settingsFallback = parseFallbackModels(override.fallbackModels);
      if (typeof override.model === "string" && override.model.trim()) {
        settingsPrimary = override.model.trim();
      }
    }
  }

  // Primary precedence: frontmatter model > settings override model > settings default
  let primary = fm.model?.trim() || settingsPrimary;
  if (!primary && settings?.defaultModel) {
    primary = String(settings.defaultModel).trim();
  }

  // Merge fallbacks: frontmatter first, then settings (deduped).
  const merged: string[] = [];
  const seen = new Set<string>(primary ? [primary] : []);
  for (const m of [...fmFallback, ...settingsFallback]) {
    if (!seen.has(m)) {
      seen.add(m);
      merged.push(m);
    }
  }

  return { primaryModel: primary, fallbackModels: merged };
}
