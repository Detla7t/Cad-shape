// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Loads the Rust kernels before every test file (rstest `setupFiles`), so code calling them
// synchronously runs under Node as it does in the app after `initRust()`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initRustSync } from "../src";

initRustSync(readFileSync(resolve(import.meta.dirname, "../lib/chili_rs_bg.wasm")));
