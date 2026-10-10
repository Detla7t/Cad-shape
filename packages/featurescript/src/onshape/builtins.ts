// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { HOST_ID } from "../context/fsContext";
import type { Interpreter } from "../lang/interpreter";
import { fsMap, native, toDisplayString } from "../lang/values";
import { getDataTable } from "../std/dataTables";
import { makeId } from "../std/feature";
import { installAttributeBuiltins } from "./attributeBuiltins";
import { StdBridge } from "./bridge";
import { installEvaluationBuiltins } from "./evaluationBuiltins";
import { installFeatureBuiltins } from "./featureBuiltins";
import { installModelingBuiltins } from "./modelingBuiltins";
import { installPathBuiltins } from "./pathBuiltins";
import { installPatternBuiltins } from "./patternBuiltins";
import { installPropertyBuiltins } from "./propertyBuiltins";
import { installPureBuiltins } from "./pureBuiltins";
import type { BuiltinRegistry } from "./registry";
import { installSheetMetalBuiltins } from "./sheetMetalBuiltins";
import { installSplineBuiltins } from "./splineBuiltins";
import { installTrackingBuiltins } from "./trackingBuiltins";
import { installUtilityBuiltins } from "./utilityBuiltins";

/** Installs the `@` built-ins Onshape's std source calls; returns the bridge they convert values with. */
export function installOnshapeBuiltins(interpreter: Interpreter, version: number): StdBridge {
    const define: BuiltinRegistry = (name, impl) => interpreter.builtins.set(name, native(`@${name}`, impl));
    installPureBuiltins(define, version);
    // `println` appends the newline itself; each print is one line of output here.
    // Through the call site, so a fork's output reaches the fork's printer.
    define("print", (args, site) => {
        const text = typeof args[0] === "string" ? args[0] : toDisplayString(args[0]);
        site.print(text.endsWith("\n") ? text.slice(0, -1) : text);
        return undefined;
    });
    const bridge = new StdBridge(interpreter);
    installModelingBuiltins(define, bridge);
    installPatternBuiltins(define, bridge);
    installPathBuiltins(define, bridge);
    installAttributeBuiltins(define, bridge);
    installFeatureBuiltins(define, bridge);
    installPropertyBuiltins(define, bridge);
    installSplineBuiltins(define, bridge);
    installEvaluationBuiltins(define, bridge);
    installSheetMetalBuiltins(define, bridge);
    installUtilityBuiltins(define, bridge);
    installExtensions(interpreter, bridge);
    // Last: it wraps every op* built-in installed above to record the operations run.
    installTrackingBuiltins(interpreter, define, bridge, version);
    return bridge;
}

/**
 * Chili3d's additions to Onshape's std, visible to every studio without an import. A
 * custom feature here runs inside a body, on the body's geometry so far: `qHostBody()`
 * names that input (what the feature's picks resolve against). `getDataTable(context, name)`
 * reads a document data table (see `std/dataTables.ts`), its quantities as std `ValueWithUnits`.
 */
function installExtensions(interpreter: Interpreter, bridge: StdBridge): void {
    interpreter.std.define(
        "qHostBody",
        native("qHostBody", (args) =>
            fsMap(
                {
                    queryType: bridge.enumValue("QueryType", "CREATED_BY"),
                    featureId: makeId([HOST_ID]),
                    entityType: args[0],
                },
                "Query",
            ),
        ),
    );
    interpreter.std.define(
        "getDataTable",
        native("getDataTable", (args) => bridge.toStd(getDataTable(args[0], args[1]))),
    );
}
