// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Loading the module and its ready state — its own file so kernel wrappers can import
// `assertRustReady` without importing the package entry that re-exports them.

import init, { initSync, version } from "../lib/chili_rs.js";

export interface InitRustOptions {
    /**
     * Raw bytes of `chili_rs_bg.wasm`. Required under Node (tests, the MCP server), where
     * the glue cannot fetch the binary; omit in the browser, which loads it as an asset.
     */
    readonly wasmBinary?: BufferSource;
}

let loading: Promise<void> | undefined;
let ready = false;

/** Loads the module (idempotent; concurrent callers share one load). */
export function initRust(options?: InitRustOptions): Promise<void> {
    if (ready) return Promise.resolve();
    loading ??= (async () => {
        if (options?.wasmBinary !== undefined) initSync({ module: options.wasmBinary });
        else await init();
        ready = true;
    })();
    return loading;
}

/** Loads the module from its bytes, synchronously (idempotent). */
export function initRustSync(wasmBinary: BufferSource): void {
    if (ready) return;
    initSync({ module: wasmBinary });
    ready = true;
}

export function isRustReady(): boolean {
    return ready;
}

/** Throws unless the module is loaded: kernels are synchronous, loading is not. */
export function assertRustReady(): void {
    if (!ready) throw new Error("The Rust kernels are not loaded: await initRust() first");
}

/** The module's version — the Rust workspace version. */
export function rustVersion(): string {
    assertRustReady();
    return version();
}
