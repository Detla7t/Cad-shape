// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    Id,
    type INodeIcon,
    type INodeSceneless,
    Node,
    serializable,
    serialize,
} from "@chili3d/core";

export interface FeatureStudioNodeOptions {
    document: IDocument;
    name?: string;
    source?: string;
    id?: string;
}

/**
 * A Feature Studio: FeatureScript source stored in the document (Onshape's Feature Studio
 * tab). It has no geometry of its own — parametric bodies run the custom features it
 * exports. `source` is a recorded property, so an edit is one undo step and every body
 * using the studio rebuilds when it changes (bodies watch the studio's `source`).
 *
 * Other studios import this one by its name: `import(path : "<name>", version : "")`.
 */
@serializable()
export class FeatureStudioNode extends Node implements INodeIcon, INodeSceneless {
    get icon(): string {
        return "icon-macro";
    }

    readonly sceneless = true as const;

    constructor(options: FeatureStudioNodeOptions) {
        super(options.document, options.name ?? "Feature Studio", options.id ?? Id.generate());
        this.setPrivateValue("source", options.source ?? DEFAULT_STUDIO_SOURCE);
    }

    @serialize()
    get source(): string {
        return this.getPrivateValue("source");
    }
    set source(value: string) {
        this.setProperty("source", value);
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}

export function isFeatureStudioNode(node: unknown): node is FeatureStudioNode {
    return node instanceof FeatureStudioNode;
}

/** The starting point of a new studio: a parameterized feature that shows the main moving parts. */
export const DEFAULT_STUDIO_SOURCE = `FeatureScript 2384;
import(path : "onshape/std/geometry.fs", version : "2384.0");

annotation { "Feature Type Name" : "Rounded Plate" }
export const roundedPlate = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Width" }
        isLength(definition.width, LENGTH_BOUNDS);

        annotation { "Name" : "Height" }
        isLength(definition.height, LENGTH_BOUNDS);

        annotation { "Name" : "Thickness" }
        isLength(definition.thickness, NONNEGATIVE_LENGTH_BOUNDS);

        annotation { "Name" : "Round corners", "Default" : true }
        definition.rounded is boolean;

        if (definition.rounded)
        {
            annotation { "Name" : "Corner radius" }
            isLength(definition.radius, BLEND_BOUNDS);
        }
    }
    {
        const sketch1 = newSketch(context, id + "sketch1", {
                "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE)
        });
        skRectangle(sketch1, "rectangle", {
                "firstCorner" : vector(-definition.width / 2, -definition.height / 2),
                "secondCorner" : vector(definition.width / 2, definition.height / 2)
        });
        skSolve(sketch1);

        extrude(context, id + "extrude1", {
                "entities" : qSketchRegion(id + "sketch1"),
                "endBound" : BoundingType.BLIND,
                "depth" : definition.thickness,
                "operationType" : NewBodyOperationType.ADD
        });

        if (definition.rounded)
        {
            fillet(context, id + "fillet1", {
                    "entities" : qParallelEdges(qCreatedBy(id + "extrude1", EntityType.EDGE), Z_DIRECTION),
                    "radius" : definition.radius
            });
        }

        opDeleteBodies(context, id + "deleteSketch", {
                "entities" : qCreatedBy(id + "sketch1", EntityType.BODY)
        });
    }, { "width" : 80 * millimeter, "height" : 50 * millimeter, "thickness" : 5 * millimeter, "radius" : 6 * millimeter });
`;
