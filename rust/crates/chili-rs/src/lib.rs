// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

//! The WebAssembly module `@chili3d/rs` loads. Each kernel is a library crate of its own,
//! tested natively; this crate only binds them for JavaScript — plain numbers and typed
//! arrays across the boundary, errors as `Result<_, JsError>`, never a panic for bad input.

use wasm_bindgen::prelude::*;

mod polygon;
mod stock_sim;

/// The module's version (the workspace version), for a loaded-module check.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
