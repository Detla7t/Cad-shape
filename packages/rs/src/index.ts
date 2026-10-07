// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The Rust kernels (`rust/`), one WebAssembly module built by `npm run build:rust` into
 * `lib/` (checked in, like the OCCT module). Load it once — `initRust()` in the browser,
 * `initRustSync(bytes)` under Node — and call the kernels synchronously afterwards.
 */

export * from "./polygon";
export * from "./runtime";
