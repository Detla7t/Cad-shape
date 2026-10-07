// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Cooperative chunking for long generations on the UI thread: `await yielder.tick()` in a
 * loop returns at once until `budgetMs` has passed since the last yield, then gives the event
 * loop a turn (a macrotask, so rendering and input run).
 */
export class Yielder {
    private last = now();
    yields = 0;

    constructor(readonly budgetMs = 15) {}

    tick(): Promise<void> | undefined {
        const time = now();
        if (time - this.last < this.budgetMs) return undefined;
        this.yields++;
        return new Promise((resolve) =>
            setTimeout(() => {
                this.last = now();
                resolve();
            }, 0),
        );
    }
}

function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
