// ---------------------------------------------------------------------------
// Pi capability adapter (Spec2 §4.2, §12 Phase 0).
//
// Detects what interactive UI capabilities the Pi runtime exposes:
//   * Focusable widgets (Enter to open detail)
//   * Extension shortcuts (register a detail-open shortcut)
//   * Custom overlay components
//   * requestRender() for invalidation
//
// When a capability is missing, the adapter falls back to the
// `/cc-review-details` command as a discoverable entry point.
// ---------------------------------------------------------------------------

export interface PiUiCapabilities {
  /** Widget can receive focus and handle key input. */
  focusableWidget: boolean;
  /** Extension shortcuts are supported. */
  shortcuts: boolean;
  /** Custom overlay/panel components are supported. */
  customOverlay: boolean;
  /** requestRender() or equivalent invalidation is available. */
  requestRender: boolean;
}

export const DEFAULT_PI_UI_CAPABILITIES: PiUiCapabilities = {
  focusableWidget: false,
  shortcuts: false,
  customOverlay: false,
  requestRender: false,
};

/**
 * Detect Pi UI capabilities from the extension API.
 * Probes for known method signatures without calling them.
 */
export function detectPiUiCapabilities(pi: unknown): PiUiCapabilities {
  const caps: PiUiCapabilities = { ...DEFAULT_PI_UI_CAPABILITIES };
  if (!pi || typeof pi !== "object") return caps;

  // Focusable widget: ctx.ui.custom() with a focus option, or ctx.ui.widget()
  // with interactive mode.
  const ui = (pi as any)?.ui;
  if (ui && typeof ui === "object") {
    if (typeof ui.custom === "function") {
      // The custom() method's existence implies interactive widget support.
      // Full focus detection requires runtime probing; we conservatively
      // assume focus is available when custom() exists.
      caps.focusableWidget = true;
      caps.customOverlay = true;
    }
    if (typeof ui.requestRender === "function" || typeof ui.invalidate === "function") {
      caps.requestRender = true;
    }
  }

  // Shortcuts: ctx.registerShortcut or ctx.shortcuts.register
  const registerShortcut = (pi as any)?.registerShortcut;
  const shortcuts = (pi as any)?.shortcuts;
  if (typeof registerShortcut === "function" || (shortcuts && typeof shortcuts.register === "function")) {
    caps.shortcuts = true;
  }

  return caps;
}

/**
 * Determine the available detail-open entry points based on capabilities.
 * Returns ordered by priority (highest first).
 */
export interface DetailEntryPoint {
  kind: "widget_focus" | "shortcut" | "command";
  /** Human-readable description for the footer/help. */
  label: string;
  /** The actual key/command to trigger (for display). */
  trigger: string;
}

export function resolveDetailEntryPoints(caps: PiUiCapabilities): DetailEntryPoint[] {
  const entries: DetailEntryPoint[] = [];
  if (caps.focusableWidget) {
    entries.push({
      kind: "widget_focus",
      label: "Enter details",
      trigger: "Enter",
    });
  }
  if (caps.shortcuts) {
    entries.push({
      kind: "shortcut",
      label: "Open review details",
      trigger: "Ctrl+R",
    });
  }
  // Command fallback is always available.
  entries.push({
    kind: "command",
    label: "Open review details (command)",
    trigger: "/cc-review-details",
  });
  return entries;
}

/**
 * Format the footer hint for available entry points.
 * Shows the first available entry point + the command fallback.
 */
export function formatFooterEntryHint(caps: PiUiCapabilities): string {
  const entries = resolveDetailEntryPoints(caps);
  if (entries.length === 0) return "";
  // Show the primary entry + the command as fallback.
  const primary = entries[0]!;
  if (primary.kind === "command") {
    return `${primary.trigger} details`;
  }
  const command = entries.find((e) => e.kind === "command");
  return command ? `${primary.trigger} details · ${command.trigger}` : `${primary.trigger} details`;
}

/**
 * Whether the overlay can be rendered as a custom component.
 * When false, the overlay falls back to a message-based or widget-based view.
 */
export function canRenderCustomOverlay(caps: PiUiCapabilities): boolean {
  return caps.customOverlay && caps.focusableWidget;
}

/**
 * Register the /cc-review-details command on the extension API.
 * This is the always-available fallback entry point.
 */
export function registerDetailsCommand(
  pi: unknown,
  handler: () => void,
): void {
  const registerCommand = (pi as any)?.registerCommand;
  if (typeof registerCommand !== "function") return;
  try {
    registerCommand("cc-review-details", {
      description: "Open the CC Review detail overlay",
      handler,
    });
  } catch {
    // Command may already be registered or the API shape may differ.
    // Silently ignore — the command is a convenience fallback.
  }
}
