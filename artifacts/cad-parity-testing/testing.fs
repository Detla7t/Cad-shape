FeatureScript 3083;
// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
import(path : "onshape/std/geometry.fs", version : "3083.0");

// Sketch-based specimens derived from stdFeatures.kernel.test.ts and the
// conformance loft, sweep and draft fixtures. The same source runs in both engines.
export const specimenNames = ["Extrude", "Revolve", "Fillet", "Chamfer", "Shell",
    "Mirror", "Linear pattern", "Circular pattern", "Boolean union", "Loft",
    "Sweep", "Draft", "Thicken"];

function xy(z)
{
    return plane(vector(0, 0, z) * millimeter, vector(0, 0, 1), vector(1, 0, 0));
}

function rectangleSketch(context is Context, id is Id, corner1 is Vector, corner2 is Vector, z)
{
    const s = newSketchOnPlane(context, id, { "sketchPlane" : xy(z) });
    skRectangle(s, "rectangle", { "firstCorner" : corner1 * millimeter,
        "secondCorner" : corner2 * millimeter });
    skSolve(s);
}

function block(context is Context, id is Id, corner1 is Vector, corner2 is Vector, height)
{
    rectangleSketch(context, id + "sketch", corner1, corner2, 0);
    extrude(context, id + "extrude", { "entities" : qSketchRegion(id + "sketch"),
        "endBound" : BoundingType.BLIND, "depth" : height * millimeter });
}

function solids(id is Id)
{
    return qBodyType(qCreatedBy(id, EntityType.BODY), BodyType.SOLID);
}

export function measure(context is Context, bodies is Query) returns map
{
    const faces = qOwnedByBody(bodies, EntityType.FACE);
    const edges = qOwnedByBody(bodies, EntityType.EDGE);
    const bounds = evBox3d(context, { "topology" : bodies, "tight" : true });
    return { "solids" : size(evaluateQuery(context, bodies)),
        "faces" : size(evaluateQuery(context, faces)),
        "edges" : size(evaluateQuery(context, edges)),
        "volume" : evVolume(context, { "entities" : bodies }) / millimeter^3,
        "area" : evArea(context, { "entities" : faces }) / millimeter^2,
        "min" : bounds.minCorner / millimeter, "max" : bounds.maxCorner / millimeter };
}

export function buildSpecimen(context is Context, id is Id, index is number)
{
    if (index == 0)
        block(context, id + "base", vector(0, 0), vector(20, 10), 5);
    else if (index == 1)
    {
        const p = plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0));
        const s = newSketchOnPlane(context, id + "profile", { "sketchPlane" : p });
        skRectangle(s, "profile", { "firstCorner" : vector(10, 0) * millimeter,
            "secondCorner" : vector(20, 10) * millimeter });
        skSolve(s);
        opRevolve(context, id + "revolve", { "entities" : qSketchRegion(id + "profile"),
            "axis" : line(vector(0, 0, 0) * millimeter, vector(0, 0, 1)),
            "angleForward" : 360 * degree });
    }
    else if (index == 2 || index == 3 || index == 4 || index == 11)
    {
        block(context, id + "base", vector(0, 0), vector(20, 20), 10);
        const faces = qOwnedByBody(solids(id + "base"), EntityType.FACE);
        const vertical = qParallelEdges(qOwnedByBody(solids(id + "base"), EntityType.EDGE), Z_DIRECTION);
        const top = qCoincidesWithPlane(faces, xy(10));
        if (index == 2)
            fillet(context, id + "fillet", { "entities" : vertical, "radius" : 2 * millimeter });
        else if (index == 3)
            chamfer(context, id + "chamfer", { "entities" : vertical,
                "chamferType" : ChamferType.EQUAL_OFFSETS, "width" : 2 * millimeter });
        else if (index == 4)
            shell(context, id + "shell", { "entities" : top, "thickness" : 1 * millimeter });
        else
        {
            const bottom = qCoincidesWithPlane(faces, xy(0));
            draft(context, id + "draft", { "neutralPlane" : bottom,
                "draftFaces" : qSubtraction(faces, qUnion([bottom, top])),
                "angle" : 5 * degree, "pullDirection" : true });
        }
    }
    else if (index == 5)
    {
        block(context, id + "base", vector(5, 0), vector(20, 10), 10);
        opPlane(context, id + "plane", { "plane" : plane(vector(0, 0, 0) * millimeter, X_DIRECTION) });
        mirror(context, id + "mirror", { "patternType" : MirrorType.PART,
            "entities" : solids(id + "base"), "mirrorPlane" : qCreatedBy(id + "plane", EntityType.FACE) });
    }
    else if (index == 6)
    {
        block(context, id + "base", vector(0, 0), vector(10, 10), 10);
        opPolyline(context, id + "direction", { "points" : [vector(0, 0, 0) * millimeter,
            vector(10, 0, 0) * millimeter] });
        linearPattern(context, id + "linear", { "patternType" : PatternType.PART,
            "entities" : solids(id + "base"), "directionOne" : qCreatedBy(id + "direction", EntityType.EDGE),
            "distance" : 15 * millimeter, "instanceCount" : 3 });
    }
    else if (index == 7)
    {
        block(context, id + "base", vector(20, 0), vector(30, 5), 10);
        opPolyline(context, id + "axis", { "points" : [vector(0, 0, 0) * millimeter,
            vector(0, 0, 10) * millimeter] });
        circularPattern(context, id + "circular", { "patternType" : PatternType.PART,
            "entities" : solids(id + "base"), "axis" : qCreatedBy(id + "axis", EntityType.EDGE),
            "angle" : 360 * degree, "instanceCount" : 4, "equalSpace" : true });
    }
    else if (index == 8)
    {
        block(context, id + "a", vector(0, 0), vector(20, 20), 10);
        block(context, id + "b", vector(10, 10), vector(30, 30), 10);
        booleanBodies(context, id + "union", { "tools" : qUnion([solids(id + "a"), solids(id + "b")]),
            "operationType" : BooleanOperationType.UNION });
    }
    else if (index == 9)
    {
        for (var j in [0, 1])
        {
            const s = newSketchOnPlane(context, id + (j == 0 ? "bottom" : "top"),
                { "sketchPlane" : xy(j * 12) });
            skCircle(s, "circle", { "center" : vector(0, 0) * millimeter,
                "radius" : (j == 0 ? 5 : 2) * millimeter });
            skSolve(s);
        }
        opLoft(context, id + "loft", { "profileSubqueries" : [qSketchRegion(id + "bottom"),
            qSketchRegion(id + "top")] });
    }
    else if (index == 10)
    {
        const s = newSketchOnPlane(context, id + "profile", { "sketchPlane" : xy(0) });
        skCircle(s, "outer", { "center" : vector(0, 0) * millimeter, "radius" : 5 * millimeter });
        skCircle(s, "inner", { "center" : vector(0, 0) * millimeter, "radius" : 2 * millimeter });
        skSolve(s);
        opPolyline(context, id + "path", { "points" : [vector(0, 0, 0) * millimeter,
            vector(0, 0, 12) * millimeter] });
        opSweep(context, id + "sweep", { "profiles" : qSketchRegion(id + "profile", true),
            "path" : qCreatedBy(id + "path", EntityType.EDGE) });
    }
    else if (index == 12)
    {
        rectangleSketch(context, id + "profile", vector(0, 0), vector(20, 10), 0);
        thicken(context, id + "thicken", { "entities" : qSketchRegion(id + "profile"),
            "thickness1" : 2 * millimeter, "thickness2" : 0 * millimeter });
    }
    else
        throw "Unknown test specimen";

    // Keep the STEP gallery limited to the finished solid parts.
    opDeleteBodies(context, id + "cleanup", { "entities" : qSubtraction(qCreatedBy(id, EntityType.BODY), solids(id)) });
    setProperty(context, { "entities" : solids(id), "propertyType" : PropertyType.NAME,
        "value" : specimenNames[index] });
    return measure(context, solids(id));
}

export function buildGallery(context is Context, id is Id) returns array
{
    var results = [];
    for (var index = 0; index < size(specimenNames); index += 1)
    {
        const specimen = id + ("specimen" ~ index);
        results = append(results, buildSpecimen(context, specimen, index));
        transform(context, specimen + "placement", { "entities" : solids(specimen),
            "transformType" : TransformType.TRANSLATION_3D, "makeCopy" : false,
            "dx" : (index % 4) * 90 * millimeter,
            "dy" : floor(index / 4) * 90 * millimeter, "dz" : 0 * millimeter });
    }
    return results;
}

annotation { "Feature Type Name" : "Testing: 13 feature specimens" }
export const testingGallery = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        setVariable(context, "testingMetrics", buildGallery(context, id));
    });

// One planar sheet containing the test rectangle, circle, semicircle and hexagon.
// It remains an actual solved sketch and is exported as 2D DXF independently.
export function buildDrawing(context is Context, id is Id)
{
    const s = newSketchOnPlane(context, id, { "sketchPlane" : xy(0) });
    skRectangle(s, "rectangle", { "firstCorner" : vector(0, 0) * millimeter,
        "secondCorner" : vector(20, 10) * millimeter });
    skCircle(s, "circle", { "center" : vector(35, 5) * millimeter, "radius" : 5 * millimeter });
    skLineSegment(s, "diameter", { "start" : vector(50, 0) * millimeter,
        "end" : vector(60, 0) * millimeter });
    skArc(s, "arc", { "start" : vector(60, 0) * millimeter, "mid" : vector(55, 5) * millimeter,
        "end" : vector(50, 0) * millimeter });
    skRegularPolygon(s, "hexagon", { "center" : vector(80, 5) * millimeter,
        "firstVertex" : vector(85, 5) * millimeter, "sides" : 6 });
    skSolve(s);
}

annotation { "Feature Type Name" : "Testing: 2D sketch sheet" }
export const testingDrawing = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        buildDrawing(context, id + "drawing");
    });
