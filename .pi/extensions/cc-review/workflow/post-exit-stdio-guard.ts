import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Post-exit stdio guard.
//
// Borrowed from pi-subagents' `attachPostExitStdioGuard` (P0-2 in the
// borrowing spec). CC Review's `runSubprocess` previously resolved completion
// on the `close` event, which waits for stdio to fully close. If a child
// process exits while inherited descendants (grandchildren) keep stdout/stderr
// open, the parent can wait indefinitely — long after the actual work is done.
//
// This guard attaches a post-`exit` watchdog that destroys unended stdout/stderr
// after a short idle window (no new data) and a hard ceiling. The existing
// timeout and process-group kill behavior in `runSubprocess` remain unchanged;
// this guard only ensures the promise resolves even when stdio stays open.
//
// Design:
//   * On `exit`: arm an idle timer (reset on each `data` event) and a hard
//     ceiling timer.
//   * When the idle timer fires: destroy stdout/stderr if they haven't ended.
//   * When the hard timer fires: destroy stdout/stderr unconditionally.
//   * On `close` or `error`: clear all timers (normal completion path).
//   * Timers use `unref()` so they don't keep the event loop alive.
// ---------------------------------------------------------------------------

export interface PostExitStdioGuardOptions {
  /** Idle window: if no new stdio data arrives for this duration after exit, destroy streams. */
  idleMs: number;
  /** Hard ceiling: destroy streams after this duration post-exit regardless of activity. */
  hardMs: number;
}

/** Minimal child process shape needed by the guard (for testability). */
export interface GuardedChildProcess {
  stdout: ChildProcess["stdout"];
  stderr: ChildProcess["stderr"];
  on: ChildProcess["on"];
}

/**
 * Attach a post-exit stdio guard to a child process.
 *
 * Returns a cleanup function that clears all timers. Call it on `close`,
 * `error`, or when the subprocess result is no longer needed.
 */
export function attachPostExitStdioGuard(
  child: GuardedChildProcess,
  options: PostExitStdioGuardOptions,
): () => void {
  const { idleMs, hardMs } = options;
  let exited = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;

  const destroyUnendedStdio = () => {
    if (!stdoutEnded) {
      try { child.stdout?.destroy(); } catch { /* already destroyed */ }
    }
    if (!stderrEnded) {
      try { child.stderr?.destroy(); } catch { /* already destroyed */ }
    }
  };

  const clearTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = undefined;
    }
  };

  const armIdleTimer = () => {
    if (!exited) return;
    // Reset the idle timer on each data event — only fire when truly idle.
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(destroyUnendedStdio, idleMs);
    idleTimer.unref?.();
  };

  // Track stream end so we don't destroy already-ended streams (which is
  // harmless but noisy in debug traces).
  child.stdout?.on("end", () => {
    stdoutEnded = true;
    if (stdoutEnded && stderrEnded) clearTimers();
  });
  child.stderr?.on("end", () => {
    stderrEnded = true;
    if (stdoutEnded && stderrEnded) clearTimers();
  });

  // Reset the idle timer whenever new data arrives post-exit.
  child.stdout?.on("data", armIdleTimer);
  child.stderr?.on("data", armIdleTimer);

  child.on("exit", () => {
    exited = true;
    armIdleTimer();
    if (hardTimer) return; // already armed
    hardTimer = setTimeout(destroyUnendedStdio, hardMs);
    hardTimer.unref?.();
  });

  // Normal completion or error: clear everything.
  child.on("close", clearTimers);
  child.on("error", clearTimers);

  return clearTimers;
}

/** Default guard timings. Tuned to be generous but bounded. */
export const DEFAULT_POST_EXIT_IDLE_MS = 2_000;
export const DEFAULT_POST_EXIT_HARD_MS = 10_000;

/**
 * Resolve guard timings from environment overrides, falling back to defaults.
 * Allows tests and operators to tune the guard without code changes.
 */
export function resolvePostExitGuardTimings(
  env: NodeJS.ProcessEnv = process.env,
): PostExitStdioGuardOptions {
  const parseMs = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.floor(parsed);
  };
  return {
    idleMs: parseMs(env.CC_REVIEW_POST_EXIT_IDLE_MS, DEFAULT_POST_EXIT_IDLE_MS),
    hardMs: parseMs(env.CC_REVIEW_POST_EXIT_HARD_MS, DEFAULT_POST_EXIT_HARD_MS),
  };
}
