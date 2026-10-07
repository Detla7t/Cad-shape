// Onshape FeatureScript tutorial 1, "Create a slot feature" — the final code of the official
// FsDoc slot tutorial (cad.onshape.com/FsDoc/tutorials/), verbatim as published in
// github.com/mbartlett21/featurescript-tutorials (slot-tutorials/tutorial-1).
FeatureScript 765;
import(path : "onshape/std/geometry.fs", version : "765.0");

annotation { "Feature Type Name" : "Slot" }
export const slot = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Slot path", "Filter" : EntityType.EDGE, "MaxNumberOfPicks" : 1 }
        definition.slotPath is Query;

        annotation { "Name" : "Part to cut", "Filter" : EntityType.BODY && BodyType.SOLID, "MaxNumberOfPicks" : 1 }
        definition.partToCut is Query;

        annotation { "Name" : "Width" }
        isLength(definition.width, LENGTH_BOUNDS);
    }
    {
        opExtrude(context, id + "extrude1", {
               "entities" : definition.slotPath,
               "direction" : evOwnerSketchPlane(context, {"entity" : definition.slotPath}).normal,
               "endBound" : BoundingType.THROUGH_ALL,
               "startBound" : BoundingType.THROUGH_ALL
        });

        opThicken(context, id + "thicken1", {
               "entities" : qCreatedBy(id + "extrude1", EntityType.BODY),
               "thickness1" : definition.width / 2,
               "thickness2" : definition.width / 2
        });

        opDeleteBodies(context, id + "delete1", {
               "entities" : qCreatedBy(id + "extrude1", EntityType.BODY)
        });

        opBoolean(context, id + "boolean1", {
               "tools" : qCreatedBy(id + "thicken1", EntityType.BODY),
               "targets" : definition.partToCut,
               "operationType" : BooleanOperationType.SUBTRACTION
        });

    });
