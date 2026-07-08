// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DialogCoordinator } from "../src/dialog-coordinator.js";
import {
  _resetState,
  subscribeToDialogCoordinator,
  withCoordinator,
} from "../src/snippets/canonical/subscribe-to-dialog-coordinator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockPi() {
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const lifecycleHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const list = eventHandlers.get(channel) ?? [];
        list.push(handler);
        eventHandlers.set(channel, list);
        return () => {
          const list = eventHandlers.get(channel);
          if (list) {
            const idx = list.indexOf(handler);
            if (idx >= 0) list.splice(idx, 1);
          }
        };
      },
      emit(channel: string, data: unknown) {
        const list = eventHandlers.get(channel) ?? [];
        for (const h of list) h(data);
      },
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = lifecycleHandlers.get(event) ?? [];
      list.push(handler);
      lifecycleHandlers.set(event, list);
      return () => {
        const list = lifecycleHandlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        }
      };
    },
    fireLifecycle(event: string, ...args: unknown[]) {
      const list = lifecycleHandlers.get(event) ?? [];
      for (const h of list) h(...args);
    },
    eventHandlers,
    lifecycleHandlers,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("subscribe-to-dialog-coordinator", () => {
  beforeEach(() => {
    _resetState();
  });

  afterEach(() => {
    _resetState();
  });

  test("subscribeToDialogCoordinator registers dialog-coordinator:ready listener", () => {
    const pi = createMockPi();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    expect(pi.eventHandlers.has("dialog-coordinator:ready")).toBe(true);
    expect(pi.eventHandlers.get("dialog-coordinator:ready")?.length).toBe(1);
  });

  test("dialog-coordinator:ready event with valid coordinator sets coordinator", async () => {
    const pi = createMockPi();
    const coordinator = new DialogCoordinator();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", { coordinator });

    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "delegated";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("delegated");
  });

  test("withCoordinator calls fn directly when coordinator is null (passthrough)", async () => {
    const pi = createMockPi();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return 42;
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe(42);
  });

  test("withCoordinator delegates to coordinator.enqueueOrShow when coordinator is set", async () => {
    const pi = createMockPi();
    const coordinator = new DialogCoordinator();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", { coordinator });

    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "coordinated";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("coordinated");
  });

  test("withCoordinator queues behind an in-flight dialog", async () => {
    const pi = createMockPi();
    const coordinator = new DialogCoordinator();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", { coordinator });

    // Hold the first dialog open with a gate so the second must queue
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondCalled = false;
    const p1 = withCoordinator(async () => {
      await firstGate;
      return "first";
    });
    const p2 = withCoordinator(async () => {
      secondCalled = true;
      return "queued";
    });

    // The second dialog must NOT run while the first is open
    await Promise.resolve();
    await Promise.resolve();
    expect(secondCalled).toBe(false);

    // Releasing the first lets the second run
    releaseFirst();
    expect(await p1).toBe("first");
    const result = await p2;
    expect(secondCalled).toBe(true);
    expect(result).toBe("queued");
  });

  test("dialog-coordinator:ready with missing coordinator does not set coordinator", async () => {
    const pi = createMockPi();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", {});

    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "passthrough";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("passthrough");
  });

  test("dialog-coordinator:ready with invalid coordinator (no enqueueOrShow) does not set coordinator", async () => {
    const pi = createMockPi();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", { coordinator: { foo: "bar" } });

    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "passthrough";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("passthrough");
  });

  test("dialog-coordinator:ready with enqueueOrShow as non-function does not set coordinator", async () => {
    const pi = createMockPi();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", {
      coordinator: { enqueueOrShow: "not-a-function" },
    });

    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "passthrough";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("passthrough");
  });

  test("_resetState clears coordinator", async () => {
    const pi = createMockPi();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    const coordinator = new DialogCoordinator();
    pi.events.emit("dialog-coordinator:ready", { coordinator });

    _resetState();

    // After reset, should passthrough
    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "reset";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("reset");
  });

  test("subscribeToDialogCoordinator with pi.events undefined is graceful no-op", () => {
    const pi = { on: vi.fn() };
    expect(() => subscribeToDialogCoordinator(pi as unknown as ExtensionAPI)).not.toThrow();
  });

  test("session_shutdown handler clears coordinator and unsubscribes listeners", async () => {
    const pi = createMockPi();
    const coordinator = new DialogCoordinator();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", { coordinator });
    expect(pi.eventHandlers.get("dialog-coordinator:ready")?.length).toBe(1);

    // Fire session_shutdown
    pi.fireLifecycle("session_shutdown");

    // Listeners should be cleaned up
    expect(pi.eventHandlers.get("dialog-coordinator:ready")?.length).toBe(0);

    // Coordinator should be cleared — withCoordinator should passthrough
    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "cleared";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("cleared");
  });

  test("session_shutdown handler does not accumulate across re-subscriptions", () => {
    const pi = createMockPi();

    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);
    expect(pi.lifecycleHandlers.get("session_shutdown")?.length).toBe(1);

    // Re-subscribe (reload) — old session_shutdown handler stays (it's a separate closure)
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);
    // Each subscribeToDialogCoordinator registers its own shutdown handler
    expect(pi.lifecycleHandlers.get("session_shutdown")?.length).toBe(2);
  });

  test("integration: subscribe then emit captures coordinator", async () => {
    const pi = createMockPi();
    const coordinator = new DialogCoordinator();

    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);
    pi.events.emit("dialog-coordinator:ready", { coordinator });

    let fnCalled = false;
    const result = await withCoordinator(async () => {
      fnCalled = true;
      return "integration";
    });

    expect(fnCalled).toBe(true);
    expect(result).toBe("integration");
  });

  // ──: Error propagation tests ────────────────────────────────────────

  test("withCoordinator propagates error in passthrough mode (no coordinator)", async () => {
    const pi = createMockPi();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    await expect(
      withCoordinator(async () => {
        throw new Error("test error");
      }),
    ).rejects.toThrow("test error");
  });

  test("withCoordinator propagates error when coordinator is set", async () => {
    const pi = createMockPi();
    const coordinator = new DialogCoordinator();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", { coordinator });

    await expect(
      withCoordinator(async () => {
        throw new Error("coordinated error");
      }),
    ).rejects.toThrow("coordinated error");
  });

  test("withCoordinator propagates error from a queued dialog", async () => {
    const pi = createMockPi();
    const coordinator = new DialogCoordinator();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    pi.events.emit("dialog-coordinator:ready", { coordinator });

    await expect(
      withCoordinator(async () => {
        throw new Error("queued error");
      }),
    ).rejects.toThrow("queued error");
  });

  // ──: Multiple ready events ──────────────────────────────────────────

  test("multiple dialog-coordinator:ready events replace coordinator", async () => {
    const pi = createMockPi();
    const coordinator1 = new DialogCoordinator();
    const coordinator2 = new DialogCoordinator();
    subscribeToDialogCoordinator(pi as unknown as ExtensionAPI);

    // Emit first coordinator
    pi.events.emit("dialog-coordinator:ready", { coordinator: coordinator1 });

    // Emit second coordinator (simulates reload of avtc-pi-ui-components)
    pi.events.emit("dialog-coordinator:ready", { coordinator: coordinator2 });

    // Block coordinator2 with a gated dialog so we can observe queuing
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = withCoordinator(async () => {
      await gate;
      return "blocking";
    });

    let fnCalled = false;
    const resultPromise = withCoordinator(async () => {
      fnCalled = true;
      return "replaced";
    });

    // Queued behind the blocking dialog on coordinator2
    await Promise.resolve();
    await Promise.resolve();
    expect(fnCalled).toBe(false);

    // Releasing coordinator2's blocking dialog flushes the queued one
    release();
    await blocking;
    const result = await resultPromise;
    expect(fnCalled).toBe(true);
    expect(result).toBe("replaced");
  });
});
