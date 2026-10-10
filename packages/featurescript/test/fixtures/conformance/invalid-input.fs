// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

function(context is Context, definition is map)
{
    const id = makeId("conformance");
    fCuboid(context, id + "base", { "corner1" : vector(0,0,0) * millimeter, "corner2" : vector(20,20,12) * millimeter });
    var rejected = false;
    try {
        if (definition.operation == "spline") {
            opFitSpline(context, id + "invalid", { "points" : [vector(0,0,0) * millimeter, vector(0,0,0) * millimeter] });
        } else if (definition.operation == "parameters") {
            opFitSpline(context, id + "invalid", { "points" : [vector(0,0,0) * millimeter, vector(1,1,0) * millimeter, vector(2,0,0) * millimeter], "parameters" : [0, 0.5, 0.1] });
        } else if (definition.operation == "fill") {
            opPolyline(context, id + "open", { "points" : [vector(0,0,0) * millimeter, vector(20,0,0) * millimeter, vector(20,20,0) * millimeter] });
            opFillSurface(context, id + "invalid", { "edgesG0" : qCreatedBy(id + "open", EntityType.EDGE) });
        } else {
            const faces = qCreatedBy(id + "base", EntityType.FACE);
            const side = qCoincidesWithPlane(faces, plane(vector(0,0,0) * millimeter, vector(1,0,0)));
            opDraft(context, id + "invalid", { "draftType" : DraftType.REFERENCE_SURFACE, "draftFaces" : side,
                "referenceSurface" : plane(vector(0,0,0) * millimeter, vector(0,0,1)), "pullVec" : vector(0,0,1), "angle" : definition.angle * degree });
        }
    } catch (error) { rejected = true; }
    return { "rejected" : rejected,
        "outputs" : size(evaluateQuery(context, qCreatedBy(id + "invalid", EntityType.BODY))),
        "remainingVolume" : evVolume(context, { "entities" : qCreatedBy(id + "base", EntityType.BODY) }) / millimeter^3 };
}
