// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, XYZ } from "@chili3d/core";
import { expectArray, expectMap, expectNumber, FsMap, type FsValue, fail } from "../lang/values";
import { readDirection, readPlane, readPoint, type Vec3, vec } from "../std/geometry";
import { enumName, type StdBuilder } from "../std/registry";
import { historySource, MM_PER_METER } from "./fsContext";
import { angleDeg, definitionOf, groupByBody, kernel } from "./operations";
import { facePlane, query, relatedEntities, resolveQuery } from "./queries";
import { interpolationDerivatives } from "./splineInterpolation";

const xyz = (v: Vec3) => new XYZ(...v);
const point = (value: FsValue, name: string) => {
    const p = vec.scale(readPoint(value, name), MM_PER_METER);
    if (!p.every(Number.isFinite)) fail(`${name} must be finite`);
    return xyz(p);
};

/** Kernel operations shared by the actual Onshape std features and custom Feature Studios. */
export function installAdvancedOperations(std: StdBuilder): void {
    std.fn("opFitSpline", (args) => {
        const [ctx, id, d] = definitionOf(args, "opFitSpline");
        if (!shapeFactory.fitSpline) fail("opFitSpline requires the spline interpolation kernel");
        if (d.field("hasTargetLength") === true) fail("opFitSpline: target length is not supported yet");
        const points = expectArray(d.field("points"), "points").items.map((v, i) => point(v, `points[${i}]`));
        if (points.length < 2) fail("opFitSpline needs at least two points");
        const closed = points.length > 2 && points[0].distanceTo(points[points.length - 1]) < 1e-7;
        const n = points.length - Number(closed);
        const derivatives = new Array<XYZ | undefined>(n).fill(undefined);
        if (d.field("startDerivative") !== undefined)
            derivatives[0] = point(d.field("startDerivative"), "startDerivative");
        if (!closed && d.field("endDerivative") !== undefined)
            derivatives[n - 1] = point(d.field("endDerivative"), "endDerivative");
        for (const [first, second] of [
            ["startDerivative", "start2ndDerivative"],
            ["endDerivative", "end2ndDerivative"],
        ]) {
            if (!closed && d.field(first) !== undefined && d.field(second) !== undefined)
                fail(`opFitSpline: ${second} is not supported yet`);
        }
        if (d.field("derivatives") !== undefined) {
            if (expectMap(d.field("derivatives"), "derivatives").size > 0)
                fail("opFitSpline: interior derivative constraints are not compatible yet");
        }
        if (derivatives.some((d) => d !== undefined && d.length() < 1e-7))
            fail("opFitSpline derivatives must be nonzero");
        const cumulative = [0];
        for (let i = 1; i < points.length; i++) {
            const distance = points[i].distanceTo(points[i - 1]);
            if (distance < 1e-7) fail("opFitSpline needs distinct consecutive points");
            // Onshape uses centripetal (sqrt chord length) parameters by default.
            cumulative.push(cumulative[i - 1] + Math.sqrt(distance));
        }
        const parameters =
            d.field("parameters") === undefined
                ? cumulative.map((t) => t / cumulative[cumulative.length - 1])
                : expectArray(d.field("parameters"), "parameters").items.map((v) =>
                      expectNumber(v, "parameter"),
                  );
        if (
            parameters.length !== points.length ||
            parameters.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= parameters[i - 1]))
        )
            fail("opFitSpline parameters must match the points and strictly increase");
        const shape = kernel(
            shapeFactory.fitSpline(
                points.slice(0, n),
                parameters,
                interpolationDerivatives(points.slice(0, n), parameters, derivatives, closed),
                closed,
            ),
            "opFitSpline",
        );
        ctx.addBody(ctx.track(shape), id);
        return undefined;
    });

    std.fn("opDraft", (args) => {
        const [ctx, id, d] = definitionOf(args, "opDraft");
        if (!shapeFactory.draftTracked) fail("opDraft requires the draft kernel");
        if (enumName(d.field("draftType"), "DraftType", "draftType") !== "REFERENCE_SURFACE")
            fail("opDraft: reference-entity / parting-line draft is not supported yet");
        if (d.field("reFillet") === true || d.field("inferReferences") === true)
            fail("opDraft: refilleting and inferred parting references are not supported yet");
        const angle = angleDeg(d.field("angle"), "angle");
        if (!Number.isFinite(angle) || angle <= 0 || angle > 89.9)
            fail("opDraft angle must be between 0 and 89.9 degrees");
        const pull = readDirection(d.field("pullVec"), "pullVec");
        const reference = d.field("referenceSurface");
        let plane: { origin: Vec3; normal: Vec3 } | undefined;
        if (reference instanceof FsMap && reference.tag === "Plane")
            plane = readPlane(reference, "referenceSurface");
        else {
            const refs = resolveQuery(ctx, reference);
            if (refs.length !== 1 || refs[0].kind !== "FACE")
                fail("opDraft needs one neutral plane or planar face");
            plane = facePlane(refs[0].body.faces()[refs[0].index]);
        }
        if (!plane) fail("opDraft: curved reference surfaces are not supported yet");
        const faces = resolveQuery(ctx, d.field("draftFaces"));
        if (!faces.length || faces.some((f) => f.kind !== "FACE" || !f.body.isModelGeometry))
            fail("opDraft needs model faces");
        const tangent = resolveQuery(ctx, query("TANGENT_CONNECTED_FACES", { query: d.field("draftFaces") }));
        if (
            d.field("tangentPropagation") !== true &&
            tangent.some((f) => !faces.some((s) => s.body === f.body && s.index === f.index))
        )
            fail("opDraft cannot disable tangent propagation for this selection yet");
        // Build every result first: an invalid face in a later body cannot partially modify the Context.
        const results = [...groupByBody(d.field("tangentPropagation") === true ? tangent : faces)].map(
            ([body, indexes]) => {
                const source = historySource(body);
                const result = kernel(
                    shapeFactory.draftTracked!(
                        body.shape,
                        indexes,
                        xyz(pull),
                        xyz(vec.scale(plane!.origin, MM_PER_METER)),
                        xyz(plane!.normal),
                        angle,
                    ),
                    "opDraft",
                );
                ctx.track(result.shape);
                return { body, source, result };
            },
        );
        for (const { body, source, result } of results) ctx.rebuildBody(body, result, [source], id);
        return undefined;
    });

    std.fn("opFillSurface", (args) => {
        const [ctx, id, d] = definitionOf(args, "opFillSurface");
        if (!shapeFactory.fillSurface) fail("opFillSurface requires the fill surface kernel");
        const constraints = ["edgesG0", "edgesG1", "edgesG2"].flatMap((field, order) =>
            resolveQuery(ctx, d.field(field) ?? query("NOTHING")).map((ref) => ({ ref, order })),
        );
        if (!constraints.length || constraints.some(({ ref }) => ref.kind !== "EDGE"))
            fail("opFillSurface needs boundary edges");
        const serials = constraints.map(({ ref }) => ref.body.edgeAttrs[ref.index].serial);
        if (new Set(serials).size !== serials.length)
            fail("opFillSurface cannot assign multiple constraints to one edge");
        const supports: (IFace | undefined)[] = constraints.map(({ ref, order }) => {
            if (order === 0) return undefined;
            let faces = relatedEntities(ref, "FACE");
            const overrides = d.field("adjacentFaces");
            if (overrides !== undefined) {
                for (const value of expectArray(overrides, "adjacentFaces").items) {
                    const override = expectMap(value, "adjacentFaces entry");
                    const edges = resolveQuery(ctx, override.field("edges"));
                    if (!edges.some((edge) => edge.body === ref.body && edge.index === ref.index)) continue;
                    const chosen = resolveQuery(ctx, override.field("faces"));
                    if (
                        chosen.some(
                            (face) =>
                                face.kind !== "FACE" ||
                                !faces.some((f) => f.body === face.body && f.index === face.index),
                        )
                    )
                        fail("opFillSurface support faces must be adjacent to their boundary edges");
                    faces = chosen;
                }
            }
            if (faces.length !== 1) fail("opFillSurface G1/G2 edges need exactly one support face");
            return faces[0].body.faces()[faces[0].index];
        });
        const guides = resolveQuery(
            ctx,
            d.field("guideVertices") ?? d.field("guideEntities") ?? query("NOTHING"),
        );
        if (guides.some((v) => v.kind !== "VERTEX")) fail("opFillSurface guideVertices must be vertices");
        const result = kernel(
            shapeFactory.fillSurface(
                constraints.map(({ ref }) => ref.body.edges()[ref.index]),
                constraints.map(({ order }) => order),
                supports,
                guides.map((v) => v.body.vertices()[v.index].point()),
            ),
            "opFillSurface",
        );
        const body = ctx.addBody(ctx.track(result.shape), id);
        result.edgeMap.forEach((input, output) => {
            if (input >= 0 && body.edgeAttrs[output])
                ctx.derive(id, body.edgeAttrs[output].serial, [serials[input]], "create");
        });
        return undefined;
    });
}
