// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initRust, initRustSync, isRustReady, rustVersion } from "../src";

describe("the Rust kernels module", () => {
    test("is loaded by the test setup and reports the workspace version", () => {
        expect(isRustReady()).toBe(true);
        const cargo = readFileSync(resolve(import.meta.dirname, "../../../rust/Cargo.toml"), "utf8");
        const version = /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(rustVersion()).toBe(version);
    });

    test("loading again is a no-op", async () => {
        initRustSync(new Uint8Array([0, 1, 2]));
        await initRust();
        expect(rustVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
