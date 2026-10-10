// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

function(context is Context, definition is map)
{
    const id = makeId("conformance");
    opPolyline(context, id + "boundary", { "points" : mapArray([vector(0,0,0), vector(20,0,0), vector(20,20,definition.height), vector(0,20,0), vector(0,0,0)], function(p) { return p * millimeter; }) });
    fill(context, id + "result", { "edges" : [{ "entities" : qCreatedBy(id + "boundary", EntityType.EDGE), "continuity" : GeometricContinuity.G0 }], "surfaceOperationType" : NewSurfaceOperationType.NEW });

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
