// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Builds the Rust kernels (rust/) into packages/rs/lib: cargo → wasm32-unknown-unknown,
// wasm-bindgen (web target, TypeScript declarations), then wasm-opt when one is found
// (PATH, $WASM_OPT, or the emsdk the C++ build installs). One-time setup: `npm run setup:rust`.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "packages/rs/lib");
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });

run(
    "cargo",
    ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "chili-rs"],
    resolve(root, "rust"),
);
const built = resolve(root, "rust/target/wasm32-unknown-unknown/release/chili_rs.wasm");
run("wasm-bindgen", ["--target", "web", "--out-dir", out, "--out-name", "chili_rs", built]);

const candidates = [process.env.WASM_OPT, "wasm-opt", resolve(root, "cpp/build/emsdk/upstream/bin/wasm-opt")];
const wasmOpt = candidates.find((candidate) => {
    if (candidate === undefined) return false;
    if (candidate.includes("/")) return existsSync(candidate);
    try {
        execFileSync(candidate, ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
});
const binary = resolve(out, "chili_rs_bg.wasm");
if (wasmOpt === undefined) console.warn("wasm-opt not found: the module is left unoptimized");
else run(wasmOpt, ["-O3", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "-o", binary, binary]);
console.log(`built ${binary}`);
