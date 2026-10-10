// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import "../../../parametric/src/featurescript/modelingHost";
import { initGarlicSync } from "../../../parametric/src/sketch/garlic";

/**
 * The kernel tests run the engine the way the app does: with parametric's modeling host
 * (history completion, sketch solver, sketch-loop rules) installed and its constraint
 * solver's WASM loaded. Onshape's std solves every sketch, so std features need it.
 * Test-only: the engine itself never imports parametric (`modelingHost.kernel.test.ts`
 * covers it without a host).
 */
initGarlicSync(readFileSync(path.resolve(import.meta.dirname, "../../../parametric/lib/garlic_bg.wasm")));
