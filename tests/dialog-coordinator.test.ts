// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { DialogCoordinator } from "../src/dialog-coordinator.js";

/**
 * DialogCoordinator serializes every dialog through a single shared queue. There is no
 * manual "active mode" — a dialog that is showing holds the queue until it resolves, and
 * the next queued dialog is shown only then.
 */
describe("DialogCoordinator", () => {
  test("shows a single dialog immediately and resolves with its result", async () => {
    const coord = new DialogCoordinator();
    const result = await coord.enqueueOrShow(async () => "immediate");
    expect(result).toBe("immediate");
  });

  test("queues dialogs and shows them sequentially", async () => {
    const coord = new DialogCoordinator();
    const shown: string[] = [];

    // A gate that stays unresolved until we release it — simulates the first dialog staying open.
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = coord.enqueueOrShow(async () => {
      await firstGate; // first dialog stays "open"
      shown.push("first");
      return "result1";
    });
    const p2 = coord.enqueueOrShow(async () => {
      shown.push("second");
      return "result2";
    });

    // The second dialog must NOT run while the first is still open
    await Promise.resolve();
    await Promise.resolve();
    expect(shown).toEqual([]);

    // Release the first → it resolves, then the second runs
    releaseFirst();

    expect(await p1).toBe("result1");
    expect(await p2).toBe("result2");
    expect(shown).toEqual(["first", "second"]);
  });

  test("shows the next dialog immediately once the queue drains", async () => {
    const coord = new DialogCoordinator();

    await coord.enqueueOrShow(async () => "first"); // drains the queue

    // After the queue is empty, the next dialog shows immediately (no lingering lock)
    const result = await coord.enqueueOrShow(async () => "second");
    expect(result).toBe("second");
  });

  test("rejects only the entry that threw (loop continues to the next)", async () => {
    const coord = new DialogCoordinator();

    const p1 = coord.enqueueOrShow<string>(async () => {
      throw new Error("dialog error");
    });
    const p2 = coord.enqueueOrShow(async () => "after-error");

    await expect(p1).rejects.toThrow("dialog error");
    expect(await p2).toBe("after-error");
  });

  test("serializes three dialogs in submission order", async () => {
    const coord = new DialogCoordinator();
    const shown: string[] = [];

    const gates: Array<() => void> = [];
    const gateFor = (i: number) =>
      new Promise<void>((resolve) => {
        gates[i] = resolve;
      });

    const p1 = coord.enqueueOrShow(async () => {
      await gateFor(0);
      shown.push("first");
      return 1;
    });
    const p2 = coord.enqueueOrShow(async () => {
      await gateFor(1);
      shown.push("second");
      return 2;
    });
    const p3 = coord.enqueueOrShow(async () => {
      shown.push("third");
      return 3;
    });

    expect(shown).toEqual([]);

    gates[0]();
    expect(await p1).toBe(1);
    expect(shown).toEqual(["first"]);

    gates[1]();
    expect(await p2).toBe(2);
    expect(await p3).toBe(3);
    expect(shown).toEqual(["first", "second", "third"]);
  });

  test("a rejected dialog does not leave the coordinator locked", async () => {
    const coord = new DialogCoordinator();

    await coord
      .enqueueOrShow<string>(async () => {
        throw new Error("boom");
      })
      .catch(() => {});

    // Coordinator must still accept + show the next dialog immediately
    const result = await coord.enqueueOrShow(async () => "after");
    expect(result).toBe("after");
  });
});
