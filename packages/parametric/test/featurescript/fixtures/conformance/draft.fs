// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

function(context is Context, definition is map)
{
    const id = makeId("conformance");
    fCuboid(context, id + "result", { "corner1" : vector(0,0,0) * millimeter, "corner2" : vector(20,20,definition.height) * millimeter });
    const before = qCreatedBy(id + "result", EntityType.FACE);
    const sides = qSubtraction(before, qUnion([
        qCoincidesWithPlane(before, plane(vector(0,0,0) * millimeter, vector(0,0,1))),
        qCoincidesWithPlane(before, plane(vector(0,0,definition.height) * millimeter, vector(0,0,1))) ]));
    opDraft(context, id + "draft", { "draftType" : DraftType.REFERENCE_SURFACE, "draftFaces" : sides,
        "referenceSurface" : plane(vector(0,0,0) * millimeter, vector(0,0,1)),
        "pullVec" : vector(0,0,definition.reverse ? -1 : 1), "angle" : definition.angle * degree });

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
