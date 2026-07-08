// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const NO_OPTIONS: SelectWithNoteOption[] | null = null;
const NO_TITLE: string | null = null;

// Helper to create a dialog for testing render output
import {
  _resetBridgeState,
  NotedSelectDialog,
  type SelectWithNoteOption,
  type SelectWithNoteResult,
  setSendAndWait,
  showSelectWithNote,
  type TUILike,
} from "../src/select-with-note.js";

// editor is a private implementation detail of NotedSelectDialog; this structural
// type lets tests verify focus/text propagation without importing the concrete type.
type DialogInternals = { editor: { focused: boolean; getExpandedText(): string } };

// Helper to simulate key input via escape sequences
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";

function createDialog(
  options: SelectWithNoteOption[] | null,
  title: string | null,
  defaultIndex: number,
  timeoutMs: number,
): { dialog: NotedSelectDialog; doneResults: (SelectWithNoteResult | null)[]; getRenderCalls: () => number } {
  const doneResults: (SelectWithNoteResult | null)[] = [];
  let renderCalls = 0;
  const resolvedOptions = options ?? [
    { label: "Allow once", value: "allow" },
    { label: "Block once", value: "block" },
  ];
  const resolvedTitle = title ?? "Stash: git stash. Allow?";
  const theme = {
    fg: (_color: string, s: string) => s,
    bg: (_color: string, s: string) => s,
  } as unknown as Theme;
  const tui: TUILike = {
    requestRender() {
      renderCalls++;
    },
    terminal: { rows: 24 },
  };
  const dialog = new NotedSelectDialog(
    resolvedOptions,
    resolvedTitle,
    defaultIndex,
    theme,
    tui,
    (r) => doneResults.push(r),
    timeoutMs,
  );
  return { dialog, doneResults, getRenderCalls: () => renderCalls };
}

describe("showSelectWithNote helper — no UI fallback", () => {
  test("returns defaultOption value when no UI + no bridge + defaultOption provided", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const result = await showSelectWithNote(
      { hasUI: false, mode: "tui" },
      "Test title",
      opts,
      opts[1], // Block once
      undefined, // source
      undefined, // no timeout
    );
    expect(result).toEqual({ value: "block", note: "" });
  });

  test("returns options[0] value when no UI + no bridge + no defaultOption", async () => {
    const result = await showSelectWithNote(
      { hasUI: false, mode: "tui" },
      "Test title",
      [{ label: "Option A", value: "a" }],
      undefined,
      undefined,
      undefined, // no timeout
    );
    expect(result).toEqual({ value: "a", note: "" });
  });

  test("returns defaultOption value when hasUI=true but ctx.ui undefined + no bridge", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const result = await showSelectWithNote(
      { hasUI: true, mode: "tui" },
      "Test title",
      opts,
      opts[1],
      undefined, // source
      undefined, // no timeout
    );
    expect(result).toEqual({ value: "block", note: "" });
  });

  test("returns null when options array is empty", async () => {
    const result = await showSelectWithNote(
      { hasUI: false, mode: "tui" },
      "Test title",
      [],
      undefined,
      undefined,
      undefined,
    ); // no timeout;
    expect(result).toBeNull();
  });

  test("returns null when options array is empty with UI", async () => {
    const result = await showSelectWithNote(
      { hasUI: true, ui: { custom: () => {} } } as unknown as Parameters<typeof showSelectWithNote>[0],
      "Test title",
      [],
      undefined,
      undefined,
      undefined, // no timeout
    );
    expect(result).toBeNull();
  });
});

describe("showSelectWithNote helper — bridge forwarding (rpc child hasUI=true)", () => {
  // RPC children have hasUI=true (rpc-mode passes a real uiContext) but must forward to the
  // root over the ui-bridge instead of rendering locally. The _sendAndWait branch must run
  // ABOVE the hasUI gate so an rpc child forwards.
  const opts: SelectWithNoteOption[] = [
    { label: "Allow once", value: "allow" },
    { label: "Block once", value: "block" },
  ];

  // Track whether local render (ctx.ui.custom) was invoked.

  test("hasUI=true + bridge set → forwards via bridge (returns reply payload)", async () => {
    setSendAndWait(async () => ({ payload: { value: "allow", note: "ok" } }));
    try {
      const customSpy = vi.fn(() => undefined);
      const result = await showSelectWithNote(
        { hasUI: true, ui: { custom: customSpy } } as unknown as Parameters<typeof showSelectWithNote>[0],
        "Allow?",
        opts,
        opts[0],
        undefined,
        undefined,
      );
      expect(result).toEqual({ value: "allow", note: "ok" });
      expect(customSpy).not.toHaveBeenCalled(); // local render NOT used
    } finally {
      _resetBridgeState();
    }
  });

  test("hasUI=true + no bridge → local render", async () => {
    _resetBridgeState();
    const customSpy = vi.fn(() => undefined);
    await showSelectWithNote(
      { hasUI: true, ui: { custom: customSpy }, mode: "tui" } as unknown as Parameters<typeof showSelectWithNote>[0],
      "Allow?",
      opts,
      opts[0],
      undefined,
      undefined,
    );
    expect(customSpy).toHaveBeenCalledTimes(1);
  });

  test("hasUI=true + bridge set, dismissed (payload null) → returns null", async () => {
    // A dismissed forwarded dialog surfaces as reply.payload === null (returned as-is, NOT
    // falling through to local render or the default-option fallback).
    setSendAndWait(async () => ({ payload: null }));
    try {
      const customSpy = vi.fn(() => undefined);
      const result = await showSelectWithNote(
        { hasUI: true, ui: { custom: customSpy } } as unknown as Parameters<typeof showSelectWithNote>[0],
        "Allow?",
        opts,
        opts[0],
        undefined,
        undefined,
      );
      expect(result).toBeNull();
      expect(customSpy).not.toHaveBeenCalled();
    } finally {
      _resetBridgeState();
    }
  });
});

describe("NotedSelectDialog render", () => {
  test("renders title and all option labels", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("Stash: git stash. Allow?");
    expect(output).toContain("Allow once");
    expect(output).toContain("Block once");
  });

  test("shows cursor marker on first option by default", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Allow once/);
  });

  test("shows Note: row with placeholder when no text saved", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("Note:");
    expect(output).toContain("(Tab to edit)");
  });

  test("shows footer with navigation hints", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("navigate");
    expect(output).toContain("confirm");
    expect(output).toContain("Tab");
  });

  test("out-of-bounds defaultIndex is clamped to valid range", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 99, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Block once/); // clamped to last option
  });

  test("negative defaultIndex is clamped to 0", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, -1, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Allow once/); // clamped to first option
  });

  test("NaN defaultIndex is clamped to 0", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, NaN, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Allow once/); // clamped to first option
  });

  test("custom defaultIndex places cursor on second option", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 1, 0);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Block once/);
  });
});

describe("NotedSelectDialog — Focusable interface", () => {
  test("focused getter returns false by default", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    expect(dialog.focused).toBe(false);
  });

  test("focused setter sets value and is readable via getter", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.focused = true;
    expect(dialog.focused).toBe(true);
    dialog.focused = false;
    expect(dialog.focused).toBe(false);
  });

  test("focused setter propagates to editor when in edit mode", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB); // enter edit mode
    // editor is a private implementation detail — cast to verify focus propagation
    const editor = (dialog as unknown as DialogInternals).editor;
    dialog.focused = true;
    expect(editor.focused).toBe(true);
    dialog.focused = false;
    expect(editor.focused).toBe(false);
  });
});

describe("NotedSelectDialog handleInput — option navigation", () => {
  test("Down moves cursor to second option", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(DOWN);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Block once/);
  });

  test("Up wraps cursor from first to last option", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(UP);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Block once/);
  });

  test("Down wraps cursor from last to first option", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 1, 0); // cursor on Block
    dialog.handleInput(DOWN);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Allow once/);
  });

  test("Enter confirms first option", () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(ENTER);
    expect(doneResults).toHaveLength(1);
    expect(doneResults[0]).toEqual({ value: "allow", note: "" });
  });

  test("Enter confirms second option after cursor move", () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(DOWN);
    dialog.handleInput(ENTER);
    expect(doneResults).toHaveLength(1);
    expect(doneResults[0]).toEqual({ value: "block", note: "" });
  });

  test("Esc cancels dialog", () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(ESC);
    expect(doneResults).toEqual([null]);
  });

  test("input after done is ignored", () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(ENTER);
    expect(doneResults).toHaveLength(1);
    dialog.handleInput(DOWN);
    dialog.handleInput(ENTER);
    expect(doneResults).toHaveLength(1); // still 1, no duplicate calls
  });
});

describe("NotedSelectDialog handleInput — editor mode", () => {
  test("Tab activates note editor", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    const lines = dialog.render(60);
    const output = lines.join("\n");
    // Editor mode footer should be visible
    expect(output).toContain("Enter save");
    // No option should show cursor marker
    expect(output).not.toMatch(/>.*Allow once/);
    expect(output).not.toMatch(/>.*Block once/);
  });

  test("Enter in editor saves note and collapses", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    // Type some text
    dialog.handleInput("h");
    dialog.handleInput("i");
    // Press Enter to save note
    dialog.handleInput(ENTER);
    // Editor should be collapsed now
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("Note: hi");
    expect(output).not.toContain("Enter save");
  });

  test("editor content is cleared after saving note", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    dialog.handleInput("h");
    dialog.handleInput("i");
    dialog.handleInput(ENTER); // save note
    // Editor content should be cleared after save
    // editor is a private implementation detail — cast to verify internal state
    const editor = (dialog as unknown as DialogInternals).editor;
    expect(editor.getExpandedText()).toBe("");
  });

  test("Esc in editor reverts to last saved text", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    // First edit: save "hello"
    dialog.handleInput(TAB);
    dialog.handleInput("h");
    dialog.handleInput("e");
    dialog.handleInput("l");
    dialog.handleInput("l");
    dialog.handleInput("o");
    dialog.handleInput(ENTER); // save

    // Second edit: type more, then Esc
    dialog.handleInput(TAB);
    dialog.handleInput("x");
    dialog.handleInput(ESC); // revert

    // Should still show "hello"
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("Note: hello");
  });

  test("Esc in editor discards when no text was previously saved", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    dialog.handleInput("t");
    dialog.handleInput("e");
    dialog.handleInput("s");
    dialog.handleInput("t");
    dialog.handleInput(ESC); // discard

    // Should show empty Note: row
    const lines = dialog.render(60);
    const output = lines.join("\n");
    // No preview text
    expect(output).toContain("Note:");
    expect(output).not.toContain("test");
  });

  test("Shift+Enter in editor inserts newline", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    dialog.handleInput("a");
    // Shift+Enter sends \n when Kitty is inactive
    dialog.handleInput("\n");
    dialog.handleInput("b");
    dialog.handleInput(ENTER); // save

    // Should show multiline collapsed preview
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("a ↵ b");
  });

  test("Ctrl+Enter in editor inserts newline", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    dialog.handleInput("x");
    // Ctrl+Enter via Kitty CSI-u: codepoint 13, modifier 5 (ctrl=4 + 1)
    dialog.handleInput("\x1b[13;5u");
    dialog.handleInput("y");
    dialog.handleInput(ENTER); // save

    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("x ↵ y");
  });

  test("Kitty Cmd+Enter in editor inserts newline", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    dialog.handleInput("p");
    // Kitty Cmd+Enter: codepoint 13, modifier 9 (Win/Super=8 + 1)
    dialog.handleInput("\x1b[13;9u");
    dialog.handleInput("q");
    dialog.handleInput(ENTER); // save

    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("p ↵ q");
  });

  test("Kitty Cmd+Enter (numpad) in editor inserts newline", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    dialog.handleInput("1");
    // Kitty Cmd+Enter on numpad: codepoint 57414, modifier 9
    dialog.handleInput("\x1b[57414;9u");
    dialog.handleInput("2");
    dialog.handleInput(ENTER); // save

    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("1 ↵ 2");
  });

  test("confirm includes saved note", () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    dialog.handleInput("m");
    dialog.handleInput("y");
    dialog.handleInput(" ");
    dialog.handleInput("n");
    dialog.handleInput("o");
    dialog.handleInput("t");
    dialog.handleInput("e");
    dialog.handleInput(ENTER); // save note
    dialog.handleInput(ENTER); // confirm option

    expect(doneResults).toHaveLength(1);
    expect(doneResults[0]).toEqual({ value: "allow", note: "my note" });
  });

  test("confirm with empty note returns empty string", () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(ENTER); // confirm without editing note
    expect(doneResults).toHaveLength(1);
    expect(doneResults[0]).toEqual({ value: "allow", note: "" });
  });

  test('null→"" state transition: Tab→Enter empty→confirm yields note ""', () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    // Open editor, type nothing, save (noteText transitions null→"")
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER); // save empty note
    // Verify collapsed note shows empty state (no preview text)
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).not.toMatch(/Note:.*"/); // no quoted preview
    // Confirm the option
    dialog.handleInput(ENTER);
    expect(doneResults).toHaveLength(1);
    expect(doneResults[0]).toEqual({ value: "allow", note: "" });
  });

  test("paste expansion via getExpandedText", () => {
    const { dialog, doneResults } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    dialog.handleInput(TAB);
    // Simulate bracketed paste: \x1b[200~ ... \x1b[201~
    dialog.handleInput("\x1b[200~multi\nline\npaste\x1b[201~");
    dialog.handleInput(ENTER); // save note
    dialog.handleInput(ENTER); // confirm option

    expect(doneResults).toHaveLength(1);
    // getExpandedText().trim() should return the full pasted content
    const first = doneResults[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.note).toBe("multi\nline\npaste");
  });

  test("re-editing note preserves previous text", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    // First edit
    dialog.handleInput(TAB);
    dialog.handleInput("a");
    dialog.handleInput("b");
    dialog.handleInput(ENTER); // save

    // Re-edit
    dialog.handleInput(TAB);
    // The editor should have been populated with "ab"
    // (we can verify by saving and checking the output)
    dialog.handleInput(ENTER); // save again without changes
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toContain("Note: ab");
  });

  test("long note preview is truncated to render width", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    // Save a very long note
    const longNote = "x".repeat(200);
    dialog.handleInput(TAB);
    for (const ch of longNote) dialog.handleInput(ch);
    dialog.handleInput(ENTER); // save

    const width = 40;
    const lines = dialog.render(width);
    const noteLine = lines.find((l) => l.includes("Note:"));
    expect(noteLine).toBeDefined();
    if (!noteLine) return;
    // The note preview should be present but truncated
    // truncateToWidth may add ANSI escape codes for "..." suffix,
    // so we strip ANSI to measure visible width
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence for test stripping
    const visible = noteLine.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible.length).toBeLessThanOrEqual(width);
    expect(noteLine).toContain("Note:");
    expect(noteLine).toContain("x");
  });
});

describe("showSelectWithNote helper — local render", () => {
  test("delegates to ctx.ui.custom and returns result", async () => {
    const mockResult: SelectWithNoteResult = { value: "allow", note: "" };
    const customMock = vi.fn().mockResolvedValue(mockResult);
    const ctx = {
      hasUI: true,
      ui: {
        custom: customMock,
      },
      mode: "tui",
    };

    const result = await showSelectWithNote(
      ctx,
      "Test title",
      [{ label: "Allow once", value: "allow" }],
      undefined,
      undefined,
      undefined, // no timeout
    );

    expect(result).toEqual(mockResult);
    expect(customMock).toHaveBeenCalledOnce();
    // Verify no overlay option — dialog renders in footer area, not centered overlay
    const callArgs = customMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    if (!callArgs) return;
    expect(callArgs[1]).toBeUndefined();
    // Verify the factory function produces a NotedSelectDialog
    const factory = callArgs[0] as (
      tui: TUILike,
      theme: Theme,
      kb: unknown,
      done: (result: SelectWithNoteResult | null) => void,
    ) => NotedSelectDialog;
    const fakeDone = vi.fn();
    const dialog = factory(
      {} as TUILike,
      { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s } as Theme,
      undefined,
      fakeDone,
    );
    expect(dialog).toBeInstanceOf(NotedSelectDialog);
  });

  test("local render with source → calls withAttention(source, title, fn)", async () => {
    const mockResult: SelectWithNoteResult = { value: "allow", note: "" };
    const customMock = vi.fn().mockResolvedValue(mockResult);
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: customMock },
    };

    // Spy on withAttention to verify it's called with source + title as detail
    const notifModule = await import("../src/snippets/vendored/subscribe-to-notifications.js");
    const withAttentionSpy = vi.spyOn(notifModule, "withAttention").mockImplementation(async (_source, _detail, fn) => {
      return fn();
    });

    const result = await showSelectWithNote(
      ctx,
      "Test title",
      [{ label: "Allow once", value: "allow" }],
      undefined, // no defaultOption
      "test-source",
      undefined, // no timeout
    );

    expect(result).toEqual(mockResult);
    // source as identity, title as detail
    expect(withAttentionSpy).toHaveBeenCalledWith("test-source", "Test title", expect.any(Function));
    expect(customMock).toHaveBeenCalledOnce();

    withAttentionSpy.mockRestore();
  });

  test("local render without source → calls render directly without withAttention", async () => {
    const mockResult: SelectWithNoteResult = { value: "allow", note: "" };
    const customMock = vi.fn().mockResolvedValue(mockResult);
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: customMock },
    };

    // Spy on withAttention to verify it's NOT called
    const notifModule = await import("../src/snippets/vendored/subscribe-to-notifications.js");
    const withAttentionSpy = vi.spyOn(notifModule, "withAttention").mockImplementation(async (_source, _detail, fn) => {
      return fn();
    });

    const result = await showSelectWithNote(
      ctx,
      "Test title",
      [{ label: "Allow once", value: "allow" }],
      undefined,
      undefined,
      undefined, // no timeout
    );

    expect(result).toEqual(mockResult);
    expect(withAttentionSpy).not.toHaveBeenCalled();
    expect(customMock).toHaveBeenCalledOnce();

    withAttentionSpy.mockRestore();
  });

  test("local render with defaultOption → dialog cursor positioned on defaultOption", async () => {
    const mockResult: SelectWithNoteResult = { value: "second", note: "" };
    const customMock = vi.fn().mockResolvedValue(mockResult);
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: customMock },
    };

    const opts: SelectWithNoteOption[] = [
      { label: "First", value: "first" },
      { label: "Second", value: "second" },
    ];
    const result = await showSelectWithNote(ctx, "Test title", opts, opts[1], undefined, undefined); // no timeout;

    expect(result).toEqual(mockResult);
    expect(customMock).toHaveBeenCalledOnce();
    // Verify the factory creates dialog with cursor on defaultOption (Second)
    const firstCall = customMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) return;
    const factory = firstCall[0] as (
      tui: TUILike,
      theme: Theme,
      kb: unknown,
      done: (result: SelectWithNoteResult | null) => void,
    ) => NotedSelectDialog;
    const dialog = factory(
      {} as TUILike,
      { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s } as Theme,
      undefined,
      vi.fn(),
    );
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Second/); // cursor on second option (defaultOption)
  });

  test("local render with deserialized defaultOption → matches by value field", async () => {
    const mockResult: SelectWithNoteResult = { value: "second", note: "" };
    const customMock = vi.fn().mockResolvedValue(mockResult);
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: customMock },
    };

    const opts: SelectWithNoteOption[] = [
      { label: "First", value: "first" },
      { label: "Second", value: "second" },
    ];
    // Simulate deserialized object (different reference, same value)
    const deserializedDefault = { label: "Second", value: "second" } as SelectWithNoteOption;
    const result = await showSelectWithNote(ctx, "Test title", opts, deserializedDefault, undefined, undefined); // no timeout;

    expect(result).toEqual(mockResult);
    expect(customMock).toHaveBeenCalledOnce();
    const firstCall = customMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) return;
    const factory = firstCall[0] as (
      tui: TUILike,
      theme: Theme,
      kb: unknown,
      done: (result: SelectWithNoteResult | null) => void,
    ) => NotedSelectDialog;
    const dialog = factory(
      {} as TUILike,
      { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s } as Theme,
      undefined,
      vi.fn(),
    );
    const lines = dialog.render(60);
    const output = lines.join("\n");
    expect(output).toMatch(/>.*Second/); // value-based match finds correct option
  });
});

describe("showSelectWithNote helper — bridge forwarding", () => {
  test("bridge payload includes defaultOption and source when bridge available", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const capturedPayload: unknown[] = [];
    const sendAndWaitMock = vi.fn().mockImplementation(async (opts2: unknown) => {
      capturedPayload.push((opts2 as { payload: unknown }).payload);
      return { payload: { value: "block", note: "" } };
    });
    const { setSendAndWait } = await import("../src/select-with-note.js");
    setSendAndWait(sendAndWaitMock);

    try {
      await showSelectWithNote(
        { hasUI: false, mode: "tui" },
        "Test title",
        opts,
        opts[1], // defaultOption = Block once
        "guardrail", // source
        undefined, // no timeout
      );

      expect(sendAndWaitMock).toHaveBeenCalledOnce();
      expect(capturedPayload[0]).toEqual({
        title: "Test title",
        options: opts,
        defaultOption: opts[1],
        source: "guardrail",
      });
    } finally {
      const { _resetBridgeState } = await import("../src/select-with-note.js");
      _resetBridgeState();
    }
  });

  test("bridge payload forwards timeoutMs so a forwarded ask-with-timeout dialog auto-resolves at root", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const capturedPayload: unknown[] = [];
    const sendAndWaitMock = vi.fn().mockImplementation(async (callOpts: unknown) => {
      capturedPayload.push((callOpts as { payload: unknown }).payload);
      return { payload: { value: "allow", note: "" } };
    });
    const { setSendAndWait } = await import("../src/select-with-note.js");
    setSendAndWait(sendAndWaitMock);

    try {
      // No local UI + bridge available ⇒ forwarded to root. The subagent's 15m timeout must reach
      // the root-side dialog (payload.timeoutMs) so it auto-resolves instead of hanging.
      await showSelectWithNote({ hasUI: false, mode: "tui" }, "Test title", opts, opts[0], "guardrail", 15 * 60_000);

      expect(sendAndWaitMock).toHaveBeenCalledOnce();
      // Outer call `timeoutMs` is the RPC wait (Infinity), not the dialog timeout.
      expect((sendAndWaitMock.mock.calls[0][0] as { timeoutMs: number }).timeoutMs).toBe(Infinity);
      // The dialog timeout is forwarded inside the payload.
      expect(capturedPayload[0]).toMatchObject({
        title: "Test title",
        options: opts,
        defaultOption: opts[0],
        source: "guardrail",
        timeoutMs: 15 * 60_000,
      });
    } finally {
      const { _resetBridgeState } = await import("../src/select-with-note.js");
      _resetBridgeState();
    }
  });
});

describe("NotedSelectDialog — countdown line", () => {
  test("renders countdown line when a timeout is armed", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 15 * 60_000);
    const output = dialog.render(60).join("\n");
    expect(output).toContain("⏳");
    // Label is derived from the default option (options[defaultIndex] = "Allow once").
    expect(output).toContain('Auto-resolves to "Allow once"');
    expect(output).toContain("15:00");
  });

  test("omits countdown line when no timeout (timeoutMs = 0)", () => {
    const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 0);
    const output = dialog.render(60).join("\n");
    expect(output).not.toContain("⏳");
  });

  test("countdown remaining decreases toward zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      // Construct at t=0 with a 15m timeout ⇒ deadline = 15m.
      const { dialog } = createDialog(NO_OPTIONS, NO_TITLE, 0, 15 * 60_000);
      // The countdown ticker invalidates each second in production; mirror that here so the
      // width-cached render recomputes with the new remaining time.
      const renderFresh = () => {
        dialog.invalidate();
        return dialog.render(60).join("\n");
      };
      expect(renderFresh()).toContain("15:00");
      vi.setSystemTime(5 * 60_000);
      expect(renderFresh()).toContain("10:00");
      vi.setSystemTime(14 * 60_000 + 30_000);
      expect(renderFresh()).toContain("0:30");
      // Past deadline clamps to 0:00 (never negative)
      vi.setSystemTime(20 * 60_000);
      expect(renderFresh()).toContain("0:00");
    } finally {
      vi.useRealTimers();
    }
  });

  test("countdown ticker invalidates + requests re-render every second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { dialog, getRenderCalls } = createDialog(NO_OPTIONS, NO_TITLE, 0, 15 * 60_000);
      const before = getRenderCalls();
      vi.advanceTimersByTime(1000);
      expect(getRenderCalls()).toBe(before + 1);
      vi.advanceTimersByTime(3000);
      expect(getRenderCalls()).toBe(before + 4);
      dialog.dispose();
      // After dispose, the ticker must stop
      const afterDispose = getRenderCalls();
      vi.advanceTimersByTime(5000);
      expect(getRenderCalls()).toBe(afterDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  test("countdown ticker stops on resolve (Enter)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { dialog, getRenderCalls } = createDialog(NO_OPTIONS, NO_TITLE, 0, 15 * 60_000);
      dialog.handleInput(ENTER);
      const afterResolve = getRenderCalls();
      vi.advanceTimersByTime(5000);
      expect(getRenderCalls()).toBe(afterResolve);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("showSelectWithNote helper — timeout auto-resolve to defaultOption", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fake ctx.ui.custom that invokes the factory and resolves via the factory's done(). */
  function fakeCustomCtx() {
    let resolveFn: ((r: SelectWithNoteResult | null) => void) | undefined;
    let dialog: { handleInput(data: string): void } | undefined;
    const customMock = vi
      .fn()
      .mockImplementation(
        (
          factory: (
            tui: TUILike,
            theme: Theme,
            kb: unknown,
            done: (r: SelectWithNoteResult | null) => void,
          ) => { handleInput(data: string): void },
        ) => {
          const promise = new Promise<SelectWithNoteResult | null>((resolve) => {
            resolveFn = resolve;
          });
          dialog = factory(
            { requestRender() {}, terminal: { rows: 24 } } as TUILike,
            { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s } as Theme,
            undefined,
            (r) => resolveFn?.(r),
          );
          return promise;
        },
      );
    return {
      ctx: { hasUI: true, ui: { custom: customMock }, mode: "tui" } as unknown as Parameters<
        typeof showSelectWithNote
      >[0],
      customMock,
      /** Drive the underlying dialog's input (e.g. DOWN then ENTER to pick the non-default). */
      input: (data: string) => dialog?.handleInput(data),
      /** Simulate the user confirming the currently-highlighted option. */
      userConfirm: () => dialog?.handleInput("\r"),
    };
  }

  test("auto-resolves with defaultOption value after timeoutMs when user does not respond", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const { ctx } = fakeCustomCtx();

    const pending = showSelectWithNote(ctx, "Stash: git stash. Allow?", opts, opts[0], undefined, 15 * 60_000);
    let settled: SelectWithNoteResult | null | undefined;
    pending.then((r) => {
      settled = r;
    });

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    // defaultOption was "Allow once" → timeout resolves with allow
    expect(result).toEqual({ value: "allow", note: "" });
    expect(settled).toEqual({ value: "allow", note: "" });
  });

  test("timeout default follows defaultOption (block)", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const { ctx } = fakeCustomCtx();

    const pending = showSelectWithNote(ctx, "Title", opts, opts[1], undefined, 15 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const result = await pending;
    expect(result).toEqual({ value: "block", note: "" });
  });

  test("user response before timeout cancels the timer (no auto-resolve)", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const { ctx, input } = fakeCustomCtx();
    // defaultOption = opts[0] (allow). User picks the NON-default (block): Down → Enter.
    // If the timeout were not cancelled, a later tick would force-allow; the user's block must stand.
    const pending = showSelectWithNote(ctx, "Title", opts, opts[0], undefined, 15 * 60_000);

    input(DOWN);
    input(ENTER);
    const result = await pending;
    expect(result).toEqual({ value: "block", note: "" });

    // Advance well past the deadline: nothing changes (timer cancelled).
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(result).toEqual({ value: "block", note: "" });
  });

  test("no timeout (timeoutMs omitted) → dialog waits for user; user response resolves", async () => {
    const opts: SelectWithNoteOption[] = [
      { label: "Allow once", value: "allow" },
      { label: "Block once", value: "block" },
    ];
    const { ctx, userConfirm } = fakeCustomCtx();
    const pending = showSelectWithNote(ctx, "Title", opts, opts[0], undefined, undefined); // no timeout;
    userConfirm();
    const result = await pending;
    expect(result).toEqual({ value: "allow", note: "" });
  });
});
