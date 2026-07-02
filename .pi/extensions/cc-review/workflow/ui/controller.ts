// ---------------------------------------------------------------------------
// Compact widget controller (Spec2 §7, Phase 1).
//
// Registers the widget once per workflow run and updates via invalidate /
// requestRender instead of re-registering on every refresh.
// ---------------------------------------------------------------------------

import type { CcReviewUiSnapshot } from "./model.ts";
import { renderCompactWidget } from "./compact-widget.ts";
import { WIDGET_MAX_WIDTH_DEFAULT } from "../ui.ts";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const SPINNER_INTERVAL_MS = 120;

export interface CcReviewUiController {
  mount(initial: CcReviewUiSnapshot): void;
  update(next: CcReviewUiSnapshot): void;
  dispose(): void;
}

export interface CcReviewUiControllerContext {
  ui?: {
    setWidget?: (
      id: string,
      content:
        | string[]
        | undefined
        | ((
            tui: unknown,
            theme: { fg: (color: string, text: string) => string },
          ) => { render?: (width: number) => string[]; invalidate?: () => void }),
    ) => void;
    requestRender?: () => void;
    invalidate?: () => void;
    theme?: { fg?: (color: string, text: string) => string };
  };
}

export function createCcReviewUiController(ctx: CcReviewUiControllerContext): CcReviewUiController {
  let snapshot: CcReviewUiSnapshot | undefined;
  let mounted = false;
  let disposed = false;
  let spinnerFrameIndex = 0;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let requestRenderRef: (() => void) | undefined;

  const getSpinnerFrame = (): string | undefined => {
    const hasRunningTask = snapshot?.tasks.some((task) => task.status === "running") ?? false;
    if (!hasRunningTask) return undefined;
    return SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length];
  };

  const stopSpinner = (): void => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  const syncSpinner = (): void => {
    const shouldSpin = snapshot?.tasks.some((task) => task.status === "running") ?? false;
    if (!shouldSpin) {
      stopSpinner();
      return;
    }
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerFrameIndex = (spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
      requestRenderRef?.();
    }, SPINNER_INTERVAL_MS);
  };

  const renderLines = (width: number): string[] => {
    if (!snapshot) return [];
    return renderCompactWidget(snapshot, {
      width,
      spinnerFrame: getSpinnerFrame(),
    }).lines;
  };

  const requestRender = (): void => {
    ctx.ui?.requestRender?.();
    ctx.ui?.invalidate?.();
  };

  const ensureMounted = (): void => {
    if (mounted || disposed || !ctx?.ui?.setWidget || !snapshot) return;

    const uiTheme = ctx.ui.theme;
    if (uiTheme && typeof uiTheme.fg === "function") {
      ctx?.ui?.setWidget?.("cc-review-widget", () => ({
        render: (renderWidth: number) => renderLines(renderWidth),
        invalidate: () => {
          requestRender();
        },
      }));
    } else {
      ctx?.ui?.setWidget?.("cc-review-widget", renderLines(WIDGET_MAX_WIDTH_DEFAULT));
    }

    mounted = true;
    requestRenderRef = requestRender;
  };

  const applySnapshot = (next: CcReviewUiSnapshot): void => {
    snapshot = next;
    syncSpinner();
    if (!mounted) {
      ensureMounted();
    } else {
      requestRender();
    }
  };

  return {
    mount(initial) {
      if (disposed) return;
      applySnapshot(initial);
    },
    update(next) {
      if (disposed) return;
      applySnapshot(next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopSpinner();
      ctx?.ui?.setWidget?.("cc-review-widget", undefined);
      mounted = false;
      snapshot = undefined;
      requestRenderRef = undefined;
    },
  };
}
