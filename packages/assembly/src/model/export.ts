// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, type IShapeConverter, Result } from "@chili3d/core";
import type { AssemblyEvaluation } from "./evaluate";

/**
 * Exporting an assembly: every placed solid, at its placement. The kernel formats (STEP,
 * IGES, BREP, STL) are written from these shapes directly; the 3D view exports the mesh formats
 * (glTF, 3MF, OBJ, PLY) through the application's data exchange from its scene nodes, which
 * carry the same placements.
 */

/** Owned, placed copies of the assembly's solids (dispose them). Located, not copied geometry. */
export function placedShapes(evaluation: AssemblyEvaluation): IShape[] {
    return evaluation.parts.map((part) => part.shape.transformed(part.placement));
}

export type KernelFormat = ".step" | ".iges" | ".brep" | ".stl";

export function exportAssemblyShapes(
    evaluation: AssemblyEvaluation,
    format: KernelFormat,
    converter: IShapeConverter = shapeConverter,
): Result<string | Uint8Array> {
    if (evaluation.parts.length === 0) return Result.err("The assembly has no parts to export");
    // A located copy shares geometry with its source; STEP/IGES writers need it transformed.
    const shapes = evaluation.parts.map((part) => part.shape.transformedMul(part.placement));
    try {
        return write(format, shapes, converter);
    } finally {
        for (const shape of shapes) shape.dispose();
    }
}

function write(
    format: KernelFormat,
    shapes: IShape[],
    converter: IShapeConverter,
): Result<string | Uint8Array> {
    switch (format) {
        case ".step":
            return converter.convertToSTEP(...shapes);
        case ".iges":
            return converter.convertToIGES(...shapes);
        case ".stl":
            return converter.convertToSTL(shapes, { binary: true });
        case ".brep": {
            const compound = shapeFactory.combine(shapes);
            if (!compound.isOk) return Result.err(compound.error);
            try {
                return converter.convertToBrep(compound.value);
            } finally {
                compound.value.dispose();
            }
        }
        default:
            return Result.err(`Unsupported format ${String(format)}`);
    }
}
