// Onshape FeatureScript tutorial 2, "Add sketch geometry" — the final code of the official
// FsDoc slot tutorial (cad.onshape.com/FsDoc/tutorials/), verbatim as published in
// github.com/mbartlett21/featurescript-tutorials (slot-tutorials/tutorial-2).
FeatureScript 765;
import(path : "onshape/std/geometry.fs", version : "765.0");

export const SLOT_WIDTH_BOUNDS =
{
    (meter)      : [1e-5, 0.0025, 500],
    (centimeter) : 0.25,
    (millimeter) : 2.5,
    (inch)       : 0.1,
    (foot)       : 0.01,
    (yard)       : 0.0025
} as LengthBoundSpec;

export const BUMP_HEIGHT_BOUNDS =
{
    (meter)      : [1e-5, 0.00025, 500],
    (centimeter) : 0.025,
    (millimeter) : 0.25,
    (inch)       : 0.01,
    (foot)       : 0.001,
    (yard)       : 0.00025
} as LengthBoundSpec;

annotation { "Feature Type Name" : "Slot" }
export const slot = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Slot path", "Filter" : EntityType.EDGE && SketchObject.YES && GeometryType.LINE, "MaxNumberOfPicks" : 1 }
        definition.slotPath is Query;

        annotation { "Name" : "Part to cut", "Filter" : EntityType.BODY && BodyType.SOLID, "MaxNumberOfPicks" : 1 }
        definition.partToCut is Query;

        annotation { "Name" : "Width" }
        isLength(definition.width, SLOT_WIDTH_BOUNDS);

        annotation { "Name" : "Add bumps", "Default" : true }
        definition.addBumps is boolean;

        if (definition.addBumps)
        {
            annotation { "Name" : "Bump height" }
            isLength(definition.bumpHeight, BUMP_HEIGHT_BOUNDS);
        }
    }
    {
        var endPoints is Query = qVertexAdjacent(definition.slotPath, EntityType.VERTEX);
        // debug(context, endPoints);

        var startPosition is Vector = evVertexPoint(context, {
                "vertex" : qNthElement(endPoints, 0)
        });
        var endPosition is Vector = evVertexPoint(context, {
                "vertex" : qNthElement(endPoints, 1)
        });
        // debug(context, startPosition);

        var xDirection is Vector = normalize(endPosition - startPosition);
        var zDirection is Vector = evOwnerSketchPlane(context, {
                "entity" : definition.slotPath
        }).normal;

        var cSys is CoordSystem = coordSystem(startPosition, xDirection, zDirection);
        // debug(context, cSys);

        var sketchPlane is Plane = plane(cSys);

        var sketch1 = newSketchOnPlane(context, id + "sketch1", {
                "sketchPlane" : sketchPlane
        });

        var slotLength is ValueWithUnits = norm(endPosition - startPosition);
        skRectangle(sketch1, "rectangle1", {
                "firstCorner" :  vector(0 * inch,    definition.width / 2),
                "secondCorner" : vector(slotLength, -definition.width / 2)
        });

        if (definition.addBumps)
        {
            var bumpDistance = slotLength / 10;          // Distance from end of slot to start of bump
            var bumpWidth    = slotLength / 5;
            var bumpHeight   = definition.bumpHeight;

            for (var side in [-1, 1])
            {
                skArc(sketch1, "arc_0_" ~ side, {
                        "start" : vector(bumpDistance, (definition.width / 2) * side),
                        "mid" : vector(bumpDistance + bumpWidth / 2, (definition.width / 2 - bumpHeight) * side),
                        "end" : vector(bumpDistance + bumpWidth, (definition.width / 2) * side)
                });

                skArc(sketch1, "arc_1_" ~ side, {
                        "start" : vector(slotLength - bumpDistance, (definition.width / 2) * side),
                        "mid" : vector(slotLength - bumpDistance - bumpWidth / 2, (definition.width / 2 - bumpHeight) * side),
                        "end" : vector(slotLength - bumpDistance - bumpWidth, (definition.width / 2) * side)
                });
            }
        }
        skSolve(sketch1);

        var regionToExtrude = qContainsPoint(qSketchRegion(id + "sketch1"), cSys.origin);
        // debug(context, regionToExtrude);

        opExtrude(context, id + "extrude1", {
              "entities" : regionToExtrude,
              "direction" : zDirection,
              "endBound" : BoundingType.THROUGH_ALL,
              "startBound" : BoundingType.THROUGH_ALL
        });

        opBoolean(context, id + "boolean1", {
              "tools" : qCreatedBy(id + "extrude1", EntityType.BODY),
              "targets" : definition.partToCut,
              "operationType" : BooleanOperationType.SUBTRACTION
        });

        opDeleteBodies(context, id + "delete1", {
              "entities" : qCreatedBy(id + "sketch1", EntityType.BODY)
        });
    });
