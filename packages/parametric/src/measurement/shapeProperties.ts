// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result, registerShapeProperties } from "@chili3d/core";
import { FsContext } from "../featurescript/context/fsContext";
import { inertiaTensor, massData } from "../featurescript/context/massProperties";

registerShapeProperties((shapes) => {
    const context = new FsContext();
    try {
        const refs = shapes.flatMap((shape) =>
            context.addHostBody(shape).map((body) => ({ body, kind: "BODY" as const, index: -1 })),
        );
        const data = massData(refs);
        return Result.ok({
            dimension: data.dimension,
            measure: data.measure * 1000 ** data.dimension,
            centroid: data.centroid.map((v) => v * 1000),
            inertia: inertiaTensor(data.second).map((row) =>
                row.map((v) => v * 1000 ** (data.dimension + 2)),
            ),
        });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    } finally {
        context.dispose();
    }
});
