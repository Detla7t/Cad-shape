// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

function(context is Context, definition is map)
{
    const id = makeId("conformance");
    const points = [vector(0,0,0), vector(5,4,1), vector(12,-4,3), vector(20,0,0)];
    var vertices = [];
    for (var i = 0; i < size(points); i += 1) {
        const pointId = id + ("point" ~ i);
        opPoint(context, pointId, { "point" : points[i] * millimeter });
        vertices = append(vertices, qCreatedBy(pointId, EntityType.VERTEX));
    }
    fitSpline(context, id + "result", { "vertices" : qUnion(vertices), "closed" : definition.closed });
    const edge = qCreatedBy(id + "result", EntityType.EDGE);
    var samples = [];
    for (var t in [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
        const tangent = evEdgeTangentLine(context, { "edge" : edge, "parameter" : t, "arcLengthParameterization" : definition.arcLength == true });
        samples = append(samples, { "point" : tangent.origin / millimeter, "direction" : tangent.direction });
    }
    return { "edges" : size(evaluateQuery(context, edge)), "length" : evLength(context, { "entities" : edge }) / millimeter, "samples" : samples };
}
