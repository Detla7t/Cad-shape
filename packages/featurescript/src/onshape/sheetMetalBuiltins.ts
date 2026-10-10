// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsContext } from "../context/fsContext";
import { resolveQuery, transientQuery } from "../context/queries";
import { FsMap, type FsValue, fail, fsArray, fsMap } from "../lang/values";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * The sheet metal built-ins of Onshape's std, for a context with no sheet metal: Onshape's
 * sheet metal models live in the kernel's own sheet metal state, which this kernel does
 * not have (Chili3d's flat-first sheet metal is a separate feature chain). So no entity
 * is sheet metal: queries for sheet metal tools find none, a vertex is never a sheet
 * metal corner, and asking for a bend or a flat transformation fails.
 */
export function installSheetMetalBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    const resolve = (args: FsValue[], field: string) => {
        if (!(args[1] instanceof FsMap)) fail("Expected a definition map");
        return resolveQuery(FsContext.of(args[0]), bridge.toLocal(args[1].field(field)));
    };

    define("sheetMetalApplyInFlat", (args) => {
        if (!(args[2] instanceof FsMap)) fail("sheetMetalApplyInFlat needs a definition map");
        const entities = resolveQuery(FsContext.of(args[0]), bridge.toLocal(args[2].field("entities")));
        if (entities.length > 0) fail("sheetMetalApplyInFlat: the entities are not sheet metal");
        return undefined;
    });
    define("evSheetMetalHoleToolBodies", (args) => {
        resolve(args, "sheetMetalHoleFaces");
        return fsMap({
            sheetMetalHoleToolBodies: fsArray([]),
            sheetMetalHoleToolWalls: fsArray([]),
            sheetMetalHoleToolTransforms: fsArray([]),
        });
    });
    define("evSheetMetalFormToolBodies", (args) => {
        resolve(args, "sheetMetalFormFaces");
        return new FsMap();
    });
    define("evSheetMetalFlatTransformation", (args) => {
        resolve(args, "face");
        fail("evSheetMetalFlatTransformation: the face is not part of a sheet metal model");
    });
    define("evSheetMetalBendUp", (args) => {
        resolve(args, "wireBody");
        fail("evSheetMetalBendUp: the wire body is not a sheet metal bend");
    });
    define("evCornerType", (args) => {
        const vertices = resolve(args, "vertex");
        if (vertices.length !== 1 || vertices[0].kind !== "VERTEX")
            fail("evCornerType: the query must evaluate to a single vertex");
        const vertex = transientQuery(vertices[0]).field("transientId");
        return fsMap({ cornerType: "NOT_A_CORNER", primaryVertex: vertex, allVertices: fsArray([vertex]) });
    });
}
