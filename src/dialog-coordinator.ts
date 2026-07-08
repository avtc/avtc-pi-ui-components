// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Cross-extension dialog coordination layer.
 *
 * Problem: multiple extensions may use `ctx.ui.custom({ overlay: true })` or `ctx.ui.select`,
 * each pushing an overlay onto the TUI stack. When one dialog is open and another extension
 * shows a dialog, the new overlay steals keyboard focus from the active dialog.
 *
 * Solution: dialogs are serialized through a single shared queue. When one dialog is being
 * shown, subsequent dialogs wait; they are shown sequentially after the active dialog resolves.
 * Because there is exactly one {@link dialogCoordinator} singleton (exported by this extension
 * and discovered by consumers via the `dialog-coordinator:ready` event), every extension's
 * `withCoordinator`/`enqueueOrShow` call enqueues against the SAME queue — coordination is
 * cross-extension, not per-extension.
 *
 * Every dialog — including long-lived modals like a settings dialog — goes through the same
 * {@link DialogCoordinator.enqueueOrShow} path. There is no separate "primary"/"secondary"
 * distinction: a dialog that is currently showing holds the queue until it resolves, and the
 * next queued dialog is shown only then.
 *
 * Usage (consumers vendor the snippet):
 * ```ts
 * // 1. Vendor src/snippets/canonical/subscribe-to-dialog-coordinator.ts
 * // 2. subscribeToDialogCoordinator(pi) once in the extension entry point
 * // 3. Wrap any blocking ctx.ui.* call:
 * const choice = await withCoordinator(() => ctx.ui.custom(myDialogComponent));
 * ```
 */

type PendingEntry<T> = {
  /** Async function that shows the dialog and returns the result. */
  show: () => Promise<T>;
  /** Resolve the outer promise with the dialog result. */
  resolve: (result: T) => void;
  /** Reject the outer promise if something goes wrong. */
  reject: (error: unknown) => void;
};

/**
 * Serializes dialog display so that two dialogs never steal focus from each other.
 *
 * Lifecycle:
 * 1. A dialog is requested via {@link enqueueOrShow} → pushed onto the queue
 * 2. If no dialog is showing, the runner picks it up immediately and shows it
 * 3. While it is showing, any further {@link enqueueOrShow} calls queue behind it
 * 4. When the showing dialog resolves, the runner picks up the next queued entry
 *
 * The runner is a single async drain loop guarded by {@link running}, so at most one
 * dialog is shown at a time.
 */
export class DialogCoordinator {
  private queue: PendingEntry<unknown>[] = [];
  private running = false;

  /**
   * Enqueue a dialog for display. It is shown as soon as any currently-showing dialog
   * resolves, then resolves this promise with whatever `showDialog` returns.
   *
   * If no dialog is currently showing, the dialog is shown immediately (on the next
   * microtask, once the runner drains the queue).
   *
   * @param showDialog - Async function that shows the dialog and returns the
   *   user's decision.
   * @returns A promise that resolves with whatever `showDialog` returns.
   */
  enqueueOrShow<T>(showDialog: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        show: showDialog as () => Promise<unknown>,
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      void this.run();
    });
  }

  /**
   * Drain the queue one dialog at a time. Guarded by {@link running} so concurrent
   * `enqueueOrShow` calls share a single drain loop. Each entry's `show` is awaited in
   * turn; an error in one dialog rejects only that entry's promise (the loop continues
   * to the next).
   */
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (entry === undefined) break;
        try {
          const result = await entry.show();
          entry.resolve(result);
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Shared singleton — used by all extensions for dialog coordination.
 * Emitted via `dialog-coordinator:ready` on `session_start` so consumers can discover it. */
export const dialogCoordinator = new DialogCoordinator();
