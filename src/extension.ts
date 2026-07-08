// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * avtc-pi-ui-components standalone extension entry point.
 *
 * Loaded by pi directly from package.json "pi.extensions".
 * Self-wires notification and UI bridge on startup.
 *
 * Consumers (e.g. guardrail) just call showSelectWithNote(ctx, title, options, defaultOption, source)
 * and it works — no extra wiring needed.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { dialogCoordinator } from "./dialog-coordinator.js";
import {
  BRIDGE_CONTENT_TYPE,
  NO_SEND_AND_WAIT,
  type SelectWithNoteOption,
  setSendAndWait,
  showSelectWithNote,
} from "./select-with-note.js";
import { subscribeToNotificationApi, withAttention } from "./snippets/vendored/subscribe-to-notifications.js";
import { type RootHandler, subscribeToUiBridge } from "./snippets/vendored/subscribe-to-subagent-ui-bridge.js";

// Idempotent wiring guard. ui-components is bundled into multiple consumers
// (feature-flow, parallel-work-guardrail). jiti's moduleCache:false gives each
// bundled copy a distinct module instance, but they share globalThis — so the
// guard lives here, mirroring the pattern used by the vendored subscribe-to-*
// snippets for shared state. Whichever consumer loads first wires once; the
// rest no-op. Prevents double-registration of bridge/notification/session handlers.
const WIRED_KEY = "__avtcPiUiComponentsWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

/** Optional logger — defaults to console. */
function _logger(level: "info" | "warn" | "error" | "debug", message: string, err: unknown | undefined): void {
  if (level === "error") console.error(message, err);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}

/** Passed as the `err` arg when a log entry has no associated error object. */
const NO_ERROR: unknown = undefined;

type SelectWithNotePayload = {
  source?: string;
  defaultOption?: SelectWithNoteOption;
  title?: string;
  options?: SelectWithNoteOption[];
  /** Dialog auto-resolve timeout forwarded from the originating (subagent) session.
   *  undefined = no timeout (wait for the human indefinitely); a positive number = auto-resolve
   *  after that many ms. Absent on payloads from older callers (treated as undefined). */
  timeoutMs?: number;
};

/** Root-side handler: render select_with_note dialog from subagents. Exported for testing. */
export const selectHandler: RootHandler<
  { hasUI: boolean; ui?: Pick<ExtensionUIContext, "custom">; mode: string },
  SelectWithNotePayload
> = async (input) => {
  const { source, defaultOption, timeoutMs } = input.payload;
  const title = input.payload.title ?? "";
  try {
    if (source) {
      const detail = input.meta?.lastMessage ? `${title}\n${input.meta.lastMessage}` : title;
      return await withAttention(source, detail, () =>
        showSelectWithNote(input.ctx, title, input.payload.options ?? [], defaultOption, source, timeoutMs),
      );
    }
    return await showSelectWithNote(input.ctx, title, input.payload.options ?? [], defaultOption, source, timeoutMs);
  } catch (e: unknown) {
    _logger(
      "warn",
      `[subscribe-to-subagent-ui-bridge] select_with_note dialog error: ${e instanceof Error ? e.message : String(e)}`,
      NO_ERROR,
    );
    return null;
  }
};

export default function uiComponentsExtension(pi: ExtensionAPI): void {
  // Idempotent: if another bundled copy already wired ui-components in this
  // process, skip. globalThis persists across jiti re-imports and pi reloads.
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;

  // Wire notification API — enables requestAttention / withAttention when pi-notification is installed
  subscribeToNotificationApi(pi);

  // Wire UI bridge — registers select_with_note handler + stores sendAndWait
  subscribeToUiBridge(pi, BRIDGE_CONTENT_TYPE, selectHandler);

  // Reset bridge state on session shutdown (and clear the guard so /reload can re-wire).
  pi.on("session_shutdown", () => {
    setSendAndWait(NO_SEND_AND_WAIT);
    g[WIRED_KEY] = false;
  });

  // Emit dialog coordinator on session_start so other extensions can discover it
  pi.on("session_start", () => {
    pi.events.emit("dialog-coordinator:ready", { coordinator: dialogCoordinator });
  });
}
