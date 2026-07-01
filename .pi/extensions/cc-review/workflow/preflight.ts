import * as fs from "node:fs";
import * as path from "node:path";

import type { ReviewProvider } from "../providers.ts";

export interface PreflightCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  resolved: {
    provider: ReviewProvider;
    providerCli: string;
    piCli?: string;
  };
}

export interface RunPreflightOptions {
  provider: ReviewProvider;
  providerCli: string;
  env?: NodeJS.ProcessEnv;
  /** When true, also verify `pi` is on PATH (subprocess fallback path). */
  checkPi?: boolean;
  /** Short timeout for optional version probes (ms). */
  probeTimeoutMs?: number;
}

function isExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathVar = env.PATH ?? process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // try next candidate
      }
    }
  }
  return false;
}

function formatMissingCliMessage(cli: string, provider: ReviewProvider): string {
  if (cli === "pi") {
    return (
      `CC Review: \`pi\` is not executable on PATH. The subagent fallback spawns ` +
      `\`pi --mode json -p --no-session\` when pi.toolManager.executeTool is unavailable. ` +
      `Install pi or ensure it is on PATH.`
    );
  }
  if (provider === "claude") {
    return (
      `CC Review: \`claude\` is not executable on PATH (selected via --provider claude or CC_REVIEW_PROVIDER=claude). ` +
      `Install Claude Code CLI and run \`claude login\`, or switch providers with \`export CC_REVIEW_PROVIDER=codex\`.`
    );
  }
  return (
    `CC Review: \`codex\` is not executable on PATH (default planner/reviewer). ` +
    `Install the Codex CLI or set \`export CC_REVIEW_PROVIDER=claude\` to use Claude instead.`
  );
}

/** Lightweight environment preflight before planning starts. */
export function runPreflight(options: RunPreflightOptions): PreflightCheckResult {
  const env = options.env ?? process.env;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isExecutableOnPath(options.providerCli, env)) {
    errors.push(formatMissingCliMessage(options.providerCli, options.provider));
  }

  let piCli: string | undefined;
  if (options.checkPi !== false) {
    piCli = "pi";
    if (!isExecutableOnPath("pi", env)) {
      warnings.push(formatMissingCliMessage("pi", options.provider));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    resolved: {
      provider: options.provider,
      providerCli: options.providerCli,
      piCli,
    },
  };
}

export function shouldSkipPreflight(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CC_REVIEW_SKIP_PREFLIGHT;
  if (raw === undefined || raw === "") return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function formatPreflightReport(result: PreflightCheckResult): string {
  const lines: string[] = ["## CC Review Environment Check", ""];
  if (result.ok) {
    lines.push("Environment OK.");
    lines.push(`- Provider: \`${result.resolved.provider}\` (\`${result.resolved.providerCli}\` on PATH)`);
    if (result.resolved.piCli) {
      lines.push(`- Subagent fallback: \`pi\` ${result.warnings.length ? "(not on PATH — in-process subagent only)" : "on PATH"}`);
    }
  } else {
    lines.push("Environment check **failed**:");
    for (const err of result.errors) {
      lines.push(`- ${err}`);
    }
  }
  for (const warn of result.warnings) {
    lines.push(`- ⚠ ${warn}`);
  }
  return lines.join("\n");
}
