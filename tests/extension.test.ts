// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// tests/extension.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { selectHandler } from "../src/extension.js";
import * as selectWithNote from "../src/select-with-note.js";
import * as notificationForwarding from "../src/snippets/vendored/subscribe-to-notifications.js";

describe("selectHandler (root-side select_with_note handler)", () => {
  test("returns null when ctx.hasUI is false", async () => {
    const result = await selectHandler({
      ctx: { hasUI: false, mode: "tui" },
      clientId: "test",
      contentType: "select_with_note",
      payload: { title: "Test", options: [] },
      meta: {},
    });
    expect(result).toBeNull();
  });

  test("wraps with withAttention when source in payload, composing lastMessage into detail", async () => {
    const withAttentionSpy = vi
      .spyOn(notificationForwarding, "withAttention")
      .mockImplementation(async (_source, _detail, fn) => fn());

    const mockSwn = vi.spyOn(selectWithNote, "showSelectWithNote").mockResolvedValue({ value: "allow", note: "" });

    try {
      const opts = [{ label: "Allow", value: "allow" }];
      await selectHandler({
        ctx: { hasUI: true, ui: { custom: vi.fn() }, mode: "tui" },
        clientId: "test",
        contentType: "select_with_note",
        payload: { title: "Test", options: opts, defaultOption: opts[0], source: "guardrail" },
        meta: { lastMessage: "last assistant msg" },
      });

      expect(withAttentionSpy).toHaveBeenCalledWith("guardrail", "Test\nlast assistant msg", expect.any(Function));
      expect(mockSwn).toHaveBeenCalledWith(expect.any(Object), "Test", opts, opts[0], "guardrail", undefined);
    } finally {
      withAttentionSpy.mockRestore();
      mockSwn.mockRestore();
    }
  });

  test("skips withAttention when no source in payload", async () => {
    const withAttentionSpy = vi
      .spyOn(notificationForwarding, "withAttention")
      .mockImplementation(async (_source, _detail, fn) => fn());

    const mockSwn = vi.spyOn(selectWithNote, "showSelectWithNote").mockResolvedValue({ value: "allow", note: "" });

    try {
      const opts = [{ label: "Allow", value: "allow" }];
      await selectHandler({
        ctx: { hasUI: true, ui: { custom: vi.fn() }, mode: "tui" },
        clientId: "test",
        contentType: "select_with_note",
        payload: { title: "Test", options: opts, defaultOption: opts[0] },
        meta: {},
      });

      expect(withAttentionSpy).not.toHaveBeenCalled();
      expect(mockSwn).toHaveBeenCalled();
    } finally {
      withAttentionSpy.mockRestore();
      mockSwn.mockRestore();
    }
  });

  test("returns null when showSelectWithNote throws", async () => {
    const spy = vi.spyOn(selectWithNote, "showSelectWithNote").mockRejectedValue(new Error("TUI crash"));
    try {
      const result = await selectHandler({
        ctx: { hasUI: true, ui: { custom: vi.fn() }, mode: "tui" },
        clientId: "test",
        contentType: "select_with_note",
        payload: { title: "Test", options: [] },
        meta: {},
      });
      expect(result).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("forwards payload.timeoutMs to showSelectWithNote (ask-with-timeout forwarded dialog)", async () => {
    const mockSwn = vi.spyOn(selectWithNote, "showSelectWithNote").mockResolvedValue({ value: "allow", note: "" });
    try {
      const opts = [{ label: "Allow", value: "allow" }];
      await selectHandler({
        ctx: { hasUI: true, ui: { custom: vi.fn() }, mode: "tui" },
        clientId: "test",
        contentType: "select_with_note",
        payload: { title: "Test", options: opts, defaultOption: opts[0], timeoutMs: 15 * 60_000 },
        meta: {},
      });
      // The subagent's 15m timeout must reach the root-side dialog so a forwarded
      // ask-allow-15m dialog auto-resolves instead of waiting indefinitely.
      const passedTimeoutMs = mockSwn.mock.calls[0]?.[5];
      expect(passedTimeoutMs).toBe(15 * 60_000);
    } finally {
      mockSwn.mockRestore();
    }
  });
});

test("with source but no lastMessage: detail is just title (no newline)", async () => {
  const withAttentionSpy = vi
    .spyOn(notificationForwarding, "withAttention")
    .mockImplementation(async (_source, _detail, fn) => fn());

  const mockSwn = vi.spyOn(selectWithNote, "showSelectWithNote").mockResolvedValue({ value: "allow", note: "" });

  try {
    const opts = [{ label: "Allow", value: "allow" }];
    await selectHandler({
      ctx: { hasUI: true, ui: { custom: vi.fn() }, mode: "tui" },
      clientId: "test",
      contentType: "select_with_note",
      payload: { title: "Test", options: opts, defaultOption: opts[0], source: "guardrail" },
      meta: {}, // no lastMessage
    });

    // detail should be just "Test" (no \n)
    expect(withAttentionSpy).toHaveBeenCalledWith("guardrail", "Test", expect.any(Function));
  } finally {
    withAttentionSpy.mockRestore();
    mockSwn.mockRestore();
  }
});

describe("uiComponentsExtension entry (idempotent wiring)", () => {
  // The entry guards against double-registration via a globalThis flag so the
  // package can be safely bundled into multiple consumers (featyard,
  // parallel-work-guardrail) — whichever loads first wires, the rest no-op.
  beforeEach(() => {
    delete (globalThis as { __avtcPiUiComponentsWired?: boolean }).__avtcPiUiComponentsWired;
  });
  afterEach(() => {
    delete (globalThis as { __avtcPiUiComponentsWired?: boolean }).__avtcPiUiComponentsWired;
    vi.restoreAllMocks();
  });

  function createMockPi() {
    const onHandlers: Record<string, number> = {};
    const eventsOnHandlers: Record<string, number> = {};
    return {
      pi: {
        on: vi.fn((event: string) => {
          onHandlers[event] = (onHandlers[event] ?? 0) + 1;
        }),
        events: {
          on: vi.fn((event: string) => {
            eventsOnHandlers[event] = (eventsOnHandlers[event] ?? 0) + 1;
          }),
          emit: vi.fn(),
        },
      },
      onHandlers,
      eventsOnHandlers,
    };
  }

  test("first load wires session_start and session_shutdown once", async () => {
    const notifSpy = vi.spyOn(notificationForwarding, "subscribeToNotificationApi").mockImplementation(() => {});
    const { selectHandler: _sh, ...bridge } = await import("../src/extension.js");
    const bridgeSpy = vi
      .spyOn(await import("../src/snippets/vendored/subscribe-to-subagent-ui-bridge.js"), "subscribeToUiBridge")
      .mockImplementation(() => {});

    const { pi, onHandlers } = createMockPi();
    bridge.default(pi);

    expect(onHandlers.session_start).toBe(1);
    expect(onHandlers.session_shutdown).toBe(1);
    expect(notifSpy).toHaveBeenCalledTimes(1);
    expect(bridgeSpy).toHaveBeenCalledTimes(1);
  });

  test("second load is a no-op (guard prevents double-registration)", async () => {
    vi.spyOn(notificationForwarding, "subscribeToNotificationApi").mockImplementation(() => {});
    const { default: entry } = await import("../src/extension.js");
    const bridgeSpy = vi
      .spyOn(await import("../src/snippets/vendored/subscribe-to-subagent-ui-bridge.js"), "subscribeToUiBridge")
      .mockImplementation(() => {});

    const { pi, onHandlers } = createMockPi();
    entry(pi); // first load wires
    entry(pi); // second load must no-op

    // Each handler registered exactly once despite two entry calls
    expect(onHandlers.session_start).toBe(1);
    expect(onHandlers.session_shutdown).toBe(1);
    expect(bridgeSpy).toHaveBeenCalledTimes(1);
  });

  test("session_shutdown clears the guard so a subsequent load re-wires (reload-safe)", async () => {
    const notifSpy = vi.spyOn(notificationForwarding, "subscribeToNotificationApi").mockImplementation(() => {});
    const { default: entry } = await import("../src/extension.js");
    const bridgeSpy = vi
      .spyOn(await import("../src/snippets/vendored/subscribe-to-subagent-ui-bridge.js"), "subscribeToUiBridge")
      .mockImplementation(() => {});

    // Capture shutdown handlers by recording the callbacks passed to pi.on.
    const shutdownHandlers: Array<() => void> = [];
    const pi = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      }),
      events: { on: vi.fn(), emit: vi.fn() },
    } as unknown as ExtensionAPI;

    entry(pi); // wires + registers one shutdown handler
    expect(bridgeSpy).toHaveBeenCalledTimes(1);

    entry(pi); // no-op (guard set)
    expect(bridgeSpy).toHaveBeenCalledTimes(1);

    // Fire the shutdown handler (as pi does before a /reload) → guard should clear.
    for (const h of shutdownHandlers) h();

    entry(pi); // reload: fresh invocation re-wires
    expect(bridgeSpy).toHaveBeenCalledTimes(2);
    expect(notifSpy).toHaveBeenCalledTimes(2);
  });
});
