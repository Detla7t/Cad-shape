// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Interpreter } from "../lang/interpreter";
import { native, toDisplayString } from "../lang/values";
import { installAttributeBuiltins } from "./attributeBuiltins";
import { StdBridge } from "./bridge";
import { installFeatureBuiltins } from "./featureBuiltins";
import { installModelingBuiltins } from "./modelingBuiltins";
import { installPatternBuiltins } from "./patternBuiltins";
import { installPureBuiltins } from "./pureBuiltins";
import type { BuiltinRegistry } from "./registry";

/** Installs the `@` built-ins Onshape's std source calls. */
export function installOnshapeBuiltins(interpreter: Interpreter, version: number): void {
    const define: BuiltinRegistry = (name, impl) => interpreter.builtins.set(name, native(`@${name}`, impl));
    installPureBuiltins(define, version);
    // `println` appends the newline itself; each print is one line of output here.
    define("print", (args) => {
        const text = typeof args[0] === "string" ? args[0] : toDisplayString(args[0]);
        interpreter.print(text.endsWith("\n") ? text.slice(0, -1) : text);
        return undefined;
    });
    const bridge = new StdBridge(interpreter);
    installModelingBuiltins(define, interpreter, bridge);
    installPatternBuiltins(define, bridge);
    installAttributeBuiltins(define, bridge);
    installFeatureBuiltins(define);
}
