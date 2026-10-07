// Onshape FeatureScript tutorial 3, "Multiple slots" — the final code of the official
// FsDoc slot tutorial (cad.onshape.com/FsDoc/tutorials/), verbatim as published in
// github.com/mbartlett21/featurescript-tutorials (slot-tutorials/tutorial-3).
FeatureScript 765;
import(path : "onshape/std/geometry.fs", version : "765.0");

import(path : "4f1bf66a78b8c01e6f1ea7f8", version : "931d833e19062ff6e437f652");

annotation { "Feature Type Name" : "Multiple Slot" }
export const multipleSlot = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Slot path", "Filter" : EntityType.EDGE && SketchObject.YES && GeometryType.LINE }
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
        for (var i = 0; i < size(evaluateQuery(context, definition.slotPath)); i += 1)
        {
            var slotDefinition = definition;
            slotDefinition.slotPath = qNthElement(definition.slotPath, i);
            slot(context, id + "slot" + i, slotDefinition);
        }
    });
