// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * avtc-pi-ui-components — Reusable TUI components for pi extensions.
 *
 * Components:
 * - `select-with-note` — Full-screen selector with note input
 * - `dialog-coordinator` — Queue-based dialog coordination preventing focus-stealing
 *
 * Bridge forwarding and notification are wired automatically by the standalone
 * extension (src/extension.ts). Consumers just call showSelectWithNote.
 */

// select-with-note
export {
  _resetBridgeState,
  BRIDGE_CONTENT_TYPE,
  NotedSelectDialog,
  type SelectWithNoteOption,
  type SelectWithNoteResult,
  setSendAndWait,
  showSelectWithNote,
  type TUILike,
} from "./src/select-with-note.js";

// modal-frame: lives in avtc-pi-settings-ui (only used by settings UIs)

// dialog-coordinator
export { DialogCoordinator, dialogCoordinator } from "./src/dialog-coordinator.js";

// Extension entry point (wires notification + UI bridge)
export { default } from "./src/extension.js";
