// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

function(context is Context, definition is map)
{
    const id = makeId("conformance");
    for (var i in [0,1]) {
        const s = newSketchOnPlane(context, id + (i == 0 ? "bottom" : "top"), { "sketchPlane" : plane(vector(0,0,i * definition.height) * millimeter, vector(0,0,1)) });
        skCircle(s, "circle", { "center" : vector(0,0) * millimeter, "radius" : (i == 0 ? 5 : 2) * millimeter });
        skSolve(s);
    }
    opLoft(context, id + "result", { "profileSubqueries" : [qSketchRegion(id + "bottom", true), qSketchRegion(id + "top", true)] });

    const bodies = qCreatedBy(id + "result", EntityType.BODY);
    const edges = qOwnedByBody(bodies, EntityType.EDGE);
    const faces = qOwnedByBody(bodies, EntityType.FACE);
    const bounds = evBox3d(context, { "topology" : bodies, "tight" : true });
    return { "bodies" : size(evaluateQuery(context, bodies)),
             "solids" : size(evaluateQuery(context, qBodyType(bodies, BodyType.SOLID))),
             "faces" : size(evaluateQuery(context, faces)),
             "edges" : size(evaluateQuery(context, edges)),
             "volume" : evVolume(context, { "entities" : bodies }) / millimeter^3,
             "area" : evArea(context, { "entities" : faces }) / millimeter^2,
             "length" : evLength(context, { "entities" : edges }) / millimeter,
             "min" : bounds.minCorner / millimeter, "max" : bounds.maxCorner / millimeter };
}
