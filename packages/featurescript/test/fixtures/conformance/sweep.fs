// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

function(context is Context, definition is map)
{
    const id = makeId("conformance");
    const s = newSketchOnPlane(context, id + "profile", { "sketchPlane" : plane(vector(0,0,0) * millimeter, vector(0,0,1)) });
    skCircle(s, "outer", { "center" : vector(0,0) * millimeter, "radius" : 5 * millimeter });
    skCircle(s, "inner", { "center" : vector(0,0) * millimeter, "radius" : 2 * millimeter });
    skSolve(s);
    opPolyline(context, id + "path", { "points" : mapArray([vector(0,0,0), vector(0,0,definition.height)], function(p) { return p * millimeter; }) });
    opSweep(context, id + "result", { "profiles" : qSketchRegion(id + "profile", true), "path" : qCreatedBy(id + "path", EntityType.EDGE) });

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
