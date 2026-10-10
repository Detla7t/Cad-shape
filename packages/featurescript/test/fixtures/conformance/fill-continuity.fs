// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

function(context is Context, definition is map)
{
    const id = makeId("conformance");
    fCuboid(context, id + "cube", { "corner1" : vector(0,0,0) * millimeter, "corner2" : vector(20,20,10) * millimeter });
    const top = qCoincidesWithPlane(qCreatedBy(id + "cube", EntityType.FACE), plane(vector(0,0,10) * millimeter, vector(0,0,1)));
    opExtractSurface(context, id + "support", { "faces" : top, "offset" : 0 * millimeter });
    const boundary = qCreatedBy(id + "support", EntityType.EDGE);
    opFillSurface(context, id + "result", {
        "edgesG0" : qNothing(), "edgesG1" : definition.order == 1 ? boundary : qNothing(),
        "edgesG2" : definition.order == 2 ? boundary : qNothing() });

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
