import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Pi CLI spawn resolution.
//
// Borrowed from pi-subagents' `getPiSpawnCommand` pattern (P0-1 in the
// borrowing spec). CC Review previously used a local heuristic that only
// covered the common macOS path. This module adds:
//
//   * Explicit environment override (`CC_REVIEW_PI_BINARY`, with
//     `PI_SUBAGENT_PI_BINARY` as a reuse-compatible alias).
//   * Package-root based Pi entrypoint resolution when running from an
//     installed Pi package.
//   * Windows support: resolve the Pi CLI script via package.json `bin` and
//     invoke it through `process.execPath`.
//   * Generic macOS/Linux fallback to `pi` on PATH.
//
// All resolution paths are injectable via `PiSpawnDeps` so unit tests can
// exercise every branch without depending on the host machine.
// ---------------------------------------------------------------------------

/** Package name of the Pi coding agent CLI. */
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/** Primary env override for the Pi binary path. */
export const CC_REVIEW_PI_BINARY_ENV = "CC_REVIEW_PI_BINARY";
/** Reuse-compatible alias that pi-subagents also reads. */
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

export interface PiSpawnDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  argv1?: string;
  existsSync?: (filePath: string) => boolean;
  readFileSync?: (filePath: string, encoding: "utf-8") => string;
  realpathSync?: (filePath: string) => string;
  /** Override the package root derived from argv[1]. Primarily for tests. */
  piPackageRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PiSpawnCommand {
  command: string;
  args: string[];
  /** Human-readable label describing which resolution path was taken. */
  source: "env_override" | "argv_script" | "current_executable" | "windows_package_bin" | "path_fallback";
}

/**
 * Walk up from `entryPoint` looking for a `package.json` whose `name` matches
 * the Pi coding agent package. Returns the directory containing that
 * package.json, or `undefined` if none is found.
 */
export function findPiPackageRootFromEntry(
  entryPoint: string,
  deps: Pick<PiSpawnDeps, "existsSync" | "readFileSync"> = {},
): string | undefined {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));
  let dir = path.dirname(entryPoint);
  let iterations = 0;
  // Guard against symlink loops / impossibly deep trees.
  while (dir !== path.dirname(dir) && iterations < 64) {
    iterations++;
    const packageJsonPath = path.join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
          name?: unknown;
        };
        if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
      } catch {
        // Malformed package.json — keep walking up.
      }
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * Resolve the Pi package root from the current process's argv[1].
 * Best-effort: returns `undefined` if argv[1] is missing or realpath fails.
 */
export function resolvePiPackageRoot(deps: PiSpawnDeps = {}): string | undefined {
  const argv1 = deps.argv1 ?? process.argv[1];
  if (!argv1) return undefined;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  try {
    const real = realpathSync(argv1);
    return findPiPackageRootFromEntry(real, deps);
  } catch {
    // realpath may fail if argv[1] is a virtual bunfs path or doesn't exist.
    return undefined;
  }
}

function isRunnableNodeScript(
  filePath: string,
  existsSync: (filePath: string) => boolean,
): boolean {
  if (!existsSync(filePath)) return false;
  return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

/**
 * Resolve the Pi CLI script path on Windows by inspecting the installed
 * package's `bin` field. Returns the script path if found and runnable,
 * otherwise `undefined` (caller falls back to `pi` on PATH).
 */
export function resolveWindowsPiCliScript(
  deps: PiSpawnDeps = {},
): string | undefined {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync =
    deps.readFileSync ??
    ((filePath, encoding) => fs.readFileSync(filePath, encoding));
  const argv1 = deps.argv1 ?? process.argv[1];

  // 1) If argv[1] itself is a runnable .mjs/.cjs/.js script, use it directly.
  if (argv1) {
    const argvPath = normalizePath(argv1);
    if (isRunnableNodeScript(argvPath, existsSync)) {
      return argvPath;
    }
  }

  // 2) Resolve via the Pi package's package.json `bin` field.
  try {
    const packageRoot = deps.piPackageRoot ?? resolvePiPackageRoot(deps);
    if (!packageRoot) return undefined;
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) return undefined;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      name?: unknown;
      bin?: string | Record<string, string>;
    };
    if (packageJson.name !== PI_CODING_AGENT_PACKAGE) return undefined;
    const binField = packageJson.bin;
    const binPath =
      typeof binField === "string"
        ? binField
        : (binField?.pi ?? Object.values(binField ?? {})[0]);
    if (!binPath) return undefined;
    const candidate = path.resolve(packageRoot, binPath);
    if (isRunnableNodeScript(candidate, existsSync)) {
      return candidate;
    }
  } catch {
    // Windows CLI resolution is optional; PATH fallback handles the rest.
    return undefined;
  }

  return undefined;
}

/**
 * Resolve the spawn command for invoking the Pi CLI.
 *
 * Resolution order:
 *   1. Explicit env override (`CC_REVIEW_PI_BINARY` or `PI_SUBAGENT_PI_BINARY`).
 *   2. On Windows: resolved package `bin` script invoked via `process.execPath`.
 *   3. argv[1] heuristic: if the current process's argv[1] looks like a Pi
 *      entry script, invoke it through `process.execPath`.
 *   4. Fallback to `pi` on PATH.
 *
 * This mirrors pi-subagents' `getPiSpawnCommand` but keeps CC Review's
 * argv[1] heuristic as an additional resolution step (it was the previous
 * default and covers the common macOS development case where pi is run
 * directly from a checkout).
 */
export function getPiSpawnCommand(
  args: string[],
  deps: PiSpawnDeps = {},
): PiSpawnCommand {
  const env = deps.env ?? process.env;

  // 1) Explicit env override — highest priority, lets users pin a specific binary.
  const piBinary =
    env[CC_REVIEW_PI_BINARY_ENV]?.trim() ||
    env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
  if (piBinary) {
    return { command: piBinary, args, source: "env_override" };
  }

  const platform = deps.platform ?? process.platform;

  // 2) Windows: resolve the CLI script from the installed package and invoke
  //    it through process.execPath (node). This avoids relying on PATH for
  //    the node runtime on Windows where shebangs are unreliable.
  if (platform === "win32") {
    const piCliPath = resolveWindowsPiCliScript(deps);
    if (piCliPath) {
      return {
        command: deps.execPath ?? process.execPath,
        args: [piCliPath, ...args],
        source: "windows_package_bin",
      };
    }
  }

  // 3) argv[1] heuristic — if the current process was launched from a Pi
  //    entry script, reuse it. This is the common development case (running
  //    `node /path/to/pi-cli.mjs` or a bun-compiled binary). We deliberately
  //    skip bun virtual filesystem paths (`/$bunfs/...`) since they are not
  //    real files on disk.
  const currentScript = deps.argv1 ?? process.argv[1];
  const existsSync = deps.existsSync ?? fs.existsSync;
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  const looksLikePiScript =
    !!currentScript &&
    !isBunVirtualScript &&
    existsSync(currentScript) &&
    (/(^|[\/\\])pi(\.[cm]?[jt]s)?$/i.test(currentScript) ||
      currentScript.includes("pi-coding-agent") ||
      currentScript.includes("@earendil-works"));

  if (looksLikePiScript) {
    // If the script is directly executable (shebang on Unix), prefer it as
    // the command. Otherwise invoke through process.execPath.
    const resolvedExecPath = deps.execPath ?? process.execPath;
    const execName = (platform === "win32"
      ? path.win32.basename(resolvedExecPath)
      : path.basename(resolvedExecPath)).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (isGenericRuntime) {
      return {
        command: deps.execPath ?? process.execPath,
        args: [currentScript, ...args],
        source: "argv_script",
      };
    }
    // Non-generic runtime (e.g. a compiled binary) — the script may be
    // executable directly.
    return {
      command: currentScript,
      args,
      source: "argv_script",
    };
  }

  // 4) A compiled Pi binary can expose a virtual or otherwise unrelated
  // argv[1]. In that case the executable itself is the Pi CLI and must be
  // reused; falling back to PATH would break installations without a global
  // `pi` shim.
  const execPath = deps.execPath ?? process.execPath;
  const execName = (platform === "win32"
    ? path.win32.basename(execPath)
    : path.basename(execPath)).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: execPath, args, source: "current_executable" };
  }

  // 5) Fallback to `pi` on PATH.
  return { command: "pi", args, source: "path_fallback" };
}

/**
 * Format the resolved Pi spawn command for preflight / debug reporting.
 * Returns a compact one-liner suitable for warnings and trace logs.
 */
export function formatResolvedPiCommand(cmd: PiSpawnCommand): string {
  const display = cmd.args.length > 0
    ? `${cmd.command} ${cmd.args[0]}${cmd.args.length > 1 ? " …" : ""}`
    : cmd.command;
  return `${display} [${cmd.source}]`;
}
