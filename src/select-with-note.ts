// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** extensions/ui-components/select-with-note.ts */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { dialogCoordinator } from "./dialog-coordinator.js";
import { withAttention } from "./snippets/vendored/subscribe-to-notifications.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SelectWithNoteOption {
  label: string;
  value: string | number | object;
}

export interface SelectWithNoteResult {
  value: string | number | object;
  note: string;
}

// ── TUILike ────────────────────────────────────────────────────────────────────
// Minimal interface satisfied by both the real TUI and a test stub.
export interface TUILike {
  requestRender(): void;
  terminal: { rows: number };
}

// ── Bridge content type ────────────────────────────────────────────────────────
/** Shared content type string for UI bridge communication. */
export const BRIDGE_CONTENT_TYPE = "select_with_note";

/**
 * Check whether this extension instance is running inside a subagent process.
 * Uses two independent signals (OR logic — either one is sufficient):
 *   ctx.mode !== "tui"   — pi-core signal (RPC children have mode="rpc").
 *   PI_SUBAGENT_PARENT_PID — avtc-pi-subagent env var (set by the parent at spawn).
 */
function isSubagentSession(ctx: { mode: string }): boolean {
  return ctx.mode !== "tui" || process.env.PI_SUBAGENT_PARENT_PID !== undefined;
}

// ── Kitty protocol helpers ────────────────────────────────────────────────────
// Kitty: Cmd+Enter on Mac = codepoint 13 (enter), modifier 9 (Win/Super=8 + 1)
// Also handle numpad enter (codepoint 57414) with same modifier.
const CMD_ENTER_SEQUENCES = ["\x1b[13;9u", "\x1b[57414;9u"] as const;
function matchesCmdEnter(data: string): boolean {
  return CMD_ENTER_SEQUENCES.includes(data as (typeof CMD_ENTER_SEQUENCES)[number]);
}

// ── NotedSelectDialog ──────────────────────────────────────────────────────────

/** When set, the dialog shows a live countdown and auto-resolves at deadlineMs.
 *  `label` is the static prefix (e.g. 'Auto-resolves to "Allow once"'); the dialog appends
 *  'in M:SS' computed from deadlineMs each render. */
export interface CountdownConfig {
  deadlineMs: number;
  label: string;
}

/** Format a remaining duration (ms) as M:SS (or H:MM:SS when ≥ 1h). Never negative. */
function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Resolved with no value — dialog cancelled / dismissed (Escape). */
const NO_DIALOG_RESULT: SelectWithNoteResult | null = null;

export class NotedSelectDialog implements Component, Focusable {
  private options: SelectWithNoteOption[];
  private title: string;
  private theme: Theme;
  private tui: TUILike;
  private done: (result: SelectWithNoteResult | null) => void;
  private countdown: CountdownConfig | undefined;

  private cursorIndex: number;
  private noteText: string | null = null; // null = never edited
  private inEditMode = false;
  private editor: Editor;

  // Render cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  // Guard: prevent done() being called more than once
  private _resolved = false;

  // Auto-resolve: when timeoutMs is defined and > 0, the dialog resolves to the FIXED default option
  // (options[defaultIndex], captured at construction — not the cursor) after timeoutMs.
  private _timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  // Countdown ticker: re-renders once per second so the remaining-time line stays fresh.
  // Cleared on resolve (markResolved) and on dispose.
  private _countdownInterval: ReturnType<typeof setInterval> | undefined;

  // Focusable interface
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.inEditMode) {
      this.editor.focused = value;
    }
  }

  constructor(
    options: SelectWithNoteOption[],
    title: string,
    defaultIndex: number,
    theme: Theme,
    tui: TUILike,
    done: (result: SelectWithNoteResult | null) => void,
    timeoutMs: number | undefined,
  ) {
    this.options = options;
    this.title = title;
    this.cursorIndex = Math.max(0, Math.min(Number.isFinite(defaultIndex) ? defaultIndex : 0, options.length - 1));
    this.theme = theme;
    this.tui = tui;
    this.done = done;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("muted", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      },
    };

    this.editor = new Editor(tui as TUI, editorTheme);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.invalidate();
      this.tui.requestRender();
    };

    // Own the timeout end-to-end: countdown + auto-resolve timer live here together so they can't
    // drift. timeoutMs undefined (or ≤ 0) means wait for the human indefinitely (no timer, no countdown).
    if (timeoutMs !== undefined && timeoutMs > 0) {
      const ms = timeoutMs;
      const fallback = options[this.cursorIndex];
      this.countdown = {
        deadlineMs: Date.now() + ms,
        label: `Auto-resolves to "${fallback.label}"`,
      };
      this._timeoutTimer = setTimeout(() => this.markResolved({ value: fallback.value, note: "" }), ms);
      // Countdown ticker: invalidate + request re-render once per second so the remaining-time
      // line updates. Stopped on resolve/dispose.
      this._countdownInterval = setInterval(() => {
        this.invalidate();
        this.tui.requestRender();
      }, 1000);
    }

    this.invalidate();
  }

  /** Mark the dialog resolved, stop the auto-resolve timer + countdown ticker, then deliver the
   *  result. `result` is the value to resolve with (user choice, timeout fallback, or null). */
  private markResolved(result: SelectWithNoteResult | null): void {
    if (this._resolved) return;
    this._resolved = true;
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = undefined;
    }
    this.done(result);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    const t = this.theme;
    const lines: string[] = [];
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    // ── Top separator ──
    add(t.fg("dim", "─".repeat(width)));

    // ── Title (word-wrapped, not selectable) ──
    const wrapped = wrapTextWithAnsi(t.fg("text", ` ${this.title}`), width - 2);
    for (const line of wrapped) {
      add(line);
    }

    // ── Countdown line (only when a timeout is armed) ──
    if (this.countdown) {
      const remaining = formatRemaining(this.countdown.deadlineMs - Date.now());
      add(t.fg("warning", ` ⏳ ${this.countdown.label} in ${remaining}`));
    }
    add("");

    // ── Option rows ──
    for (let i = 0; i < this.options.length; i++) {
      const opt = this.options[i];
      const isSelected = i === this.cursorIndex;
      // When editor is active, no option shows cursor marker
      const prefix = !this.inEditMode && isSelected ? t.fg("accent", ">") : " ";
      const labelColor = isSelected && !this.inEditMode ? "accent" : "text";
      add(`${prefix}   ${i + 1}. ${t.fg(labelColor, opt.label)}`);
    }

    // ── Note row ──
    if (this.inEditMode) {
      // Editor label
      add(t.fg("muted", "Note:"));
      // Editor render (bordered box)
      const editorLines = this.editor.render(width);
      lines.push(...editorLines);
      // Footer for editor mode
      add(t.fg("dim", "Enter save · Ctrl+Enter/Shift+Enter new line · Esc back"));
    } else if (this.noteText) {
      // Collapsed preview with saved text
      const display = this.noteText.replace(/\n/g, " ↵ ");
      add(` ${t.fg("muted", "Note:")} ${t.fg("dim", display)}`);
    } else {
      // Empty note row with placeholder
      add(` ${t.fg("muted", "Note:")} ${t.fg("dim", "(Tab to edit)")}`);
    }

    // ── Inactive footer (not shown when editor is active — editor has its own footer) ──
    if (!this.inEditMode) {
      add("");
      add(t.fg("dim", " ↑↓ navigate · Enter confirm · Tab to edit Note · Esc cancel"));
    }

    // ── Bottom separator ──
    add(t.fg("dim", "─".repeat(width)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    // Guard: once done has been called, ignore all further input
    if (this._resolved) return;

    if (this.inEditMode) {
      this.handleEditInput(data);
    } else {
      this.handleNavigationInput(data);
    }
  }

  private handleEditInput(data: string): void {
    // Esc: revert to last saved note (or discard if never saved)
    if (matchesKey(data, Key.escape)) {
      this.editor.setText(this.noteText ?? "");
      this.inEditMode = false;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Ctrl+Enter / Shift+Enter / Cmd+Enter insert newline
    // When Kitty protocol is NOT active, modifier+Enter sends \n (LF).
    // \n is matched as Enter when Kitty is inactive, so catch it before plain Enter.
    if (
      matchesKey(data, Key.ctrl("enter")) ||
      matchesKey(data, Key.shift("enter")) ||
      matchesCmdEnter(data) ||
      data === "\n"
    ) {
      this.editor.insertTextAtCursor("\n");
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Plain Enter: save note and collapse editor (only \r / Kitty Enter, NOT \n)
    if (matchesKey(data, Key.enter)) {
      const text = this.editor.getExpandedText().trim();
      this.noteText = text || "";
      this.editor.setText("");
      this.inEditMode = false;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // All other input: route to editor (onChange handles invalidate + requestRender)
    this.editor.handleInput(data);
  }

  private handleNavigationInput(data: string): void {
    const maxIndex = this.options.length - 1;

    if (matchesKey(data, Key.up)) {
      this.cursorIndex = this.cursorIndex > 0 ? this.cursorIndex - 1 : maxIndex;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.cursorIndex = this.cursorIndex < maxIndex ? this.cursorIndex + 1 : 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.markResolved({
        value: this.options[this.cursorIndex].value,
        note: this.noteText ?? "",
      });
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.inEditMode = true;
      if (this.noteText !== null) {
        this.editor.setText(this.noteText);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.markResolved(NO_DIALOG_RESULT);
      return;
    }
  }

  dispose(): void {
    // Defense-in-depth: markResolved clears these on resolve. Clear here too in case the
    // component is torn down without resolving.
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = undefined;
    }
  }
}

// ── Bridge forwarding state ──────────────────────────────────────────────────
// Stored reference to sendAndWait from pi-subagent-ui-bridge.
// Set by subscribe-to-subagent-ui-bridge.ts (vendored) via setSendAndWait().
type SendAndWaitFn = (options: {
  contentType: string;
  payload: Record<string, unknown>;
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<{ payload: unknown }>;

let _sendAndWait: SendAndWaitFn | null = null; // Lifecycle: set by registerUiBridgeHooks on pi-subagent-ui-bridge:ready, cleared on session_shutdown and by _resetBridgeState()

/** Clears the stored sendAndWait reference (no bridge fn). */
export const NO_SEND_AND_WAIT: SendAndWaitFn | null = null;

/** Set the sendAndWait reference — called by subscribe-to-subagent-ui-bridge.ts */
export function setSendAndWait(fn: SendAndWaitFn | null): void {
  _sendAndWait = fn;
}

/** Reset module state — called on session shutdown and during test cleanup. */
export function _resetBridgeState(): void {
  _sendAndWait = null;
}

// ── showSelectWithNote helper ─────────────────────────────────────────────────

/** Render the dialog locally, wrapping with notification attention if source provided.
 *  timeoutMs is forwarded to NotedSelectDialog, which owns the countdown + auto-resolve timer:
 *  timeoutMs undefined (or ≤ 0) waits for the human indefinitely; a positive number resolves
 *  to the default option (defaultIndex) after timeoutMs. */
async function renderLocally(
  ctx: { hasUI: boolean; ui?: Pick<ExtensionUIContext, "custom">; mode: string },
  title: string,
  options: SelectWithNoteOption[],
  defaultIndex: number,
  source: string | undefined,
  timeoutMs: number | undefined,
): Promise<SelectWithNoteResult | null> {
  if (!ctx.ui) return null;
  const ui = ctx.ui;
  const render = () =>
    ui.custom<SelectWithNoteResult | null>(
      (tui, theme, _kb, done) => new NotedSelectDialog(options, title, defaultIndex, theme, tui, done, timeoutMs),
    );

  if (source) {
    return withAttention(source, title, render);
  }
  return render();
}

export async function showSelectWithNote(
  ctx: { hasUI: boolean; ui?: Pick<ExtensionUIContext, "custom">; mode: string },
  title: string,
  options: SelectWithNoteOption[],
  defaultOption: SelectWithNoteOption | undefined,
  source: string | undefined,
  timeoutMs: number | undefined,
): Promise<SelectWithNoteResult | null> {
  // Guard: empty options — nothing to select
  if (!options.length) return null;

  // Resolve cursor index from defaultOption — use value-based matching for bridge deserialization compatibility
  const defaultIndex = defaultOption
    ? Math.max(
        options.findIndex((o) => o.value === defaultOption.value),
        0,
      )
    : 0;

  // Try the bridge FIRST (works for both json and rpc children). In json the child has
  // hasUI=false; in rpc the child has hasUI=true but must still forward to the root over the
  // inherited socket. A dismissed dialog returns reply.payload === null (returned as-is); only a
  // null reply object (bridge error) falls through to local render / the default-option fallback.
  if (_sendAndWait) {
    const reply = await _sendAndWait({
      contentType: BRIDGE_CONTENT_TYPE,
      payload: {
        title,
        options,
        defaultOption,
        source,
        // Forward the dialog timeout so the root session auto-resolves a forwarded ask-with-timeout
        // dialog (e.g. guardrail ask-allow-15m) after the same deadline instead of waiting
        // indefinitely. (The outer timeoutMs: Infinity below is the RPC wait for the root's reply.)
        timeoutMs,
      } as unknown as Record<string, unknown>,
      text: `Select with note: ${title}`,
      timeoutMs: Infinity,
    });
    if (reply) return reply.payload as SelectWithNoteResult | null;
  }

  // No UI available — return the default-option fallback.
  if (isSubagentSession(ctx) || !ctx.ui) {
    // No UI + no bridge → return defaultOption value (or options[0])
    return { value: (defaultOption ?? options[0]).value, note: "" };
  }

  return dialogCoordinator.enqueueOrShow(() => renderLocally(ctx, title, options, defaultIndex, source, timeoutMs));
}
